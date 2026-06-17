const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');

// ── Load .env (local dev only) ──────────────────────────────────────────────
// Render/Railway/etc. inject real env vars directly, so this is a no-op in
// production. Locally, this reads a gitignored .env file so the keys never
// have to live in this source file (which gets pushed to a git repo).
(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
})();

const API_KEY           = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY        = process.env.OPENAI_API_KEY;
const REPLICATE_KEY     = process.env.REPLICATE_API_KEY;
const PERFECTCORP_KEY   = process.env.PERFECTCORP_API_KEY;
const AILABTOOLS_KEY    = process.env.AILABTOOLS_API_KEY;
const PORT = process.env.PORT || 3000;

const missingKeys = Object.entries({ ANTHROPIC_API_KEY: API_KEY, OPENAI_API_KEY: OPENAI_KEY, REPLICATE_API_KEY: REPLICATE_KEY, PERFECTCORP_API_KEY: PERFECTCORP_KEY, AILABTOOLS_API_KEY: AILABTOOLS_KEY })
  .filter(([, v]) => !v).map(([k]) => k);
if (missingKeys.length) {
  console.warn(`\n⚠ Missing env vars: ${missingKeys.join(', ')}. Add them to a .env file (local) or your host's environment settings (production). Features needing these keys will fail until set.\n`);
}

// ── Perfect Corp (YouCam) V2 API helpers — shared by /api/face-reshape and /api/simulate ──
// V2 auth = just "Authorization: Bearer <API_KEY>", no client_secret/id_token needed.
// Flow per feature: POST file/{feature} -> PUT bytes to presigned url -> POST task/{feature} -> GET task/{feature}/{task_id} (poll)
function pcPost(apiPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(bodyObj));
    const r = https.request({
      hostname: 'yce-api-01.makeupar.com', path: apiPath, method: 'POST',
      headers: {
        'Authorization': `Bearer ${PERFECTCORP_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': body.length
      }
    }, apiRes => {
      const bufs = []; apiRes.on('data', c => bufs.push(c));
      apiRes.on('end', () => {
        const txt = Buffer.concat(bufs).toString();
        console.log(`[pc] POST ${apiPath} http:${apiRes.statusCode} body:${txt.slice(0, 500)}`);
        try { resolve({ status: apiRes.statusCode, json: JSON.parse(txt) }); }
        catch (_) { reject(new Error(`Non-JSON from ${apiPath} (http ${apiRes.statusCode}): ${txt.slice(0, 300)}`)); }
      });
    });
    r.on('error', reject); r.write(body); r.end();
  });
}

function pcGet(apiPath) {
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: 'yce-api-01.makeupar.com', path: apiPath, method: 'GET',
      headers: { 'Authorization': `Bearer ${PERFECTCORP_KEY}` }
    }, apiRes => {
      const bufs = []; apiRes.on('data', c => bufs.push(c));
      apiRes.on('end', () => {
        const txt = Buffer.concat(bufs).toString();
        console.log(`[pc] GET ${apiPath} http:${apiRes.statusCode} body:${txt.slice(0, 500)}`);
        try { resolve({ status: apiRes.statusCode, json: JSON.parse(txt) }); }
        catch (_) { reject(new Error(`Non-JSON from ${apiPath} (http ${apiRes.statusCode}): ${txt.slice(0, 300)}`)); }
      });
    });
    r.on('error', reject); r.end();
  });
}

// PUT raw bytes to a presigned URL (S3-style)
function pcPutBytes(url, headers, data) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'PUT',
      headers: { ...headers, 'Content-Length': data.length }
    }, apiRes => {
      const bufs = []; apiRes.on('data', c => bufs.push(c));
      apiRes.on('end', () => {
        console.log(`[pc] PUT upload http:${apiRes.statusCode}`);
        if (apiRes.statusCode >= 200 && apiRes.statusCode < 300) resolve();
        else reject(new Error(`Upload failed (http ${apiRes.statusCode}): ${Buffer.concat(bufs).toString().slice(0, 300)}`));
      });
    });
    r.on('error', reject); r.write(data); r.end();
  });
}

function pcFetchBuf(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects: ' + url));
    const u = new URL(url);
    https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(pcFetchBuf(res.headers.location, redirects + 1));
      }
      const bufs = []; res.on('data', c => bufs.push(c)); res.on('end', () => resolve(Buffer.concat(bufs)));
    }).on('error', reject).end();
  });
}

// Upload the photo once via the {feature} File API, get back a file_id usable by the task.
// `version` lets callers target v2.0 (makeup-vto, etc.) or v2.1 (hair-transfer, etc.) — the
// File API path differs per API version per Perfect Corp's docs.
async function pcUploadFile(feature, buf, contentType, fileName, version = 'v2.0') {
  const { json } = await pcPost(`/s2s/${version}/file/${feature}`, {
    files: [{ content_type: contentType, file_name: fileName, file_size: buf.length }]
  });
  const fileEntry = json?.data?.files?.[0];
  if (!fileEntry) throw new Error(`${feature} file upload init failed: ${JSON.stringify(json).slice(0,300)}`);
  const uploadReq = fileEntry.requests?.[0];
  if (!uploadReq) throw new Error(`${feature} file upload: no presigned request returned: ${JSON.stringify(json).slice(0,300)}`);
  await pcPutBytes(uploadReq.url, uploadReq.headers || { 'Content-Type': contentType }, buf);
  return fileEntry.file_id;
}

// Run a task and poll until success/error. `version` selects v2.0 vs v2.1 task API path.
async function pcRunTask(feature, taskBody, label, version = 'v2.0') {
  const { json: createJson } = await pcPost(`/s2s/${version}/task/${feature}`, taskBody);
  const taskId = createJson?.data?.task_id;
  if (!taskId) throw new Error(`${label}: no task_id in response: ${JSON.stringify(createJson).slice(0,300)}`);
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const { json: pollJson } = await pcGet(`/s2s/${version}/task/${feature}/${taskId}`);
    const status = pollJson?.data?.task_status || pollJson?.status;
    console.log(`[pc:${label}] poll ${i + 1} status:`, status);
    if (status === 'success' || status === 'succeeded' || status === 'completed') return pollJson.data;
    if (status === 'error' || status === 'failed') throw new Error(`${label} task failed: ${JSON.stringify(pollJson).slice(0,300)}`);
  }
  throw new Error(`${label} task timed out`);
}

// Hairstyle button id -> Perfect Corp hair-transfer template_id.
// NOTE: only "male_wavy_undercut" is confirmed (from the user's real Playground request).
// The rest are placeholders until the real template_id list (Playground "List predefined
// templates v2.1" response) is provided — swap these in once we have them.
const HAIR_TEMPLATE_MAP = {
  fringe:   'male_wavy_undercut',
  curtains: 'male_wavy_undercut',
  flow:     'male_wavy_undercut',
  sidepart: 'male_wavy_undercut',
  crop:     'male_wavy_undercut',
  buzz:     'male_wavy_undercut',
};

// Builds the confirmed makeup-vto effects array (concealer, eyebrows, eyelashes, foundation)
// for the masculine-enhancement look. Schema confirmed from Perfect Corp's own
// Playground-generated request code.
// Builds the confirmed face-reshape v2.0 task body, combining eyes adjustments
// (size/width/height/distance/angle) AND face/chin/cheekbone/jaw adjustments into one
// task, plus global skin smoothing. Both feature sets confirmed from Perfect Corp's own
// Playground-generated request code. Note: this is the upstream "face-reshape" API
// feature, distinct from this app's /api/face-reshape route (which actually runs the
// makeup-vto feature).
function buildFaceReshapeTaskBody(fileId) {
  return {
    src_file_id: fileId,
    version: '1.0',
    source: 'yco',
    features: {
      eye_size_left: 20,
      eye_size_right: 20,
      eye_width: 50,
      eye_height: 25,
      eye_distance: 0,
      eye_angle: -50,
      face_reshape_left: 0,
      face_reshape_right: 0,
      chin_reshape_left: 0,
      chin_reshape_right: 0,
      chin_length: -25,
      face_width: 0,
      cheekbones: 50,
      jaw: 50
    },
    global: {
      skin_smooth_strength: 0,
      skin_smooth_color_intensity: 0
    }
  };
}

function buildMakeupVtoTaskBody(fileId) {
  return {
    src_file_id: fileId,
    effects: [
      {
        category: 'eyebrows',
        pattern: {
          type: 'shape',
          name: 'Straight17',
          curvature: 0,
          thickness: 35,
          definition: 100
        },
        palettes: [
          { color: '#3F2E21', colorIntensity: 100, texture: 'matte' }
        ]
      },
      {
        category: 'eyelashes',
        palettes: [
          { color: '#000000', colorIntensity: 30 }
        ],
        pattern: {
          name: 'UpperDense3'
        }
      },
      {
        category: 'foundation',
        palettes: [
          {
            color: '#C99B5A',
            colorIntensity: 100,
            coverageIntensity: 50,
            glowIntensity: 50
          }
        ]
      },
      {
        category: 'concealer',
        palettes: [
          {
            colorUnderEyeIntensity: 0,
            coverageLevel: 0,
            color: '#D6AA6A',
            colorIntensity: 0
          }
        ]
      }
    ],
    version: '1.0'
  };
}

const server = http.createServer((req, res) => {

  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && req.url === '/analyze') {
    const html = fs.readFileSync(path.join(__dirname, 'glowai.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && req.url === '/experiment') {
    const html = fs.readFileSync(path.join(__dirname, 'experiment.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && req.url === '/transform') {
    const html = fs.readFileSync(path.join(__dirname, 'transform.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && req.url === '/roadmap') {
    const html = fs.readFileSync(path.join(__dirname, 'roadmap.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (req.method === 'POST' && req.url === '/api/transform') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const { imageBase64, mimeType } = JSON.parse(Buffer.concat(chunks).toString());
        const imgBuffer = Buffer.from(imageBase64, 'base64');

        // Use gpt-image-1 image edit endpoint — takes the actual photo as input
        // so identity is preserved. Only apply the one specific change.
        const prompt =
          'This is a photo of a real person. Apply ONE change only: bring the hair down onto the forehead as a natural textured fringe so it covers the upper forehead. ' +
          'Keep absolutely everything else pixel-perfect identical: face shape, skin tone, skin texture, eyes, eyebrows, nose, mouth, ears, jawline, neck, lighting, shadows, background, clothing, expression, and camera angle. ' +
          'Do not improve skin. Do not change brows. Do not alter anything except the hair falling onto the forehead. Photorealistic, same person.';

        const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
        const CRLF = '\r\n';

        // Build multipart/form-data manually (no npm needed)
        const parts = [];

        const addField = (name, value) => {
          parts.push(
            `--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}` +
            `${value}${CRLF}`
          );
        };

        addField('model', 'gpt-image-1');
        addField('prompt', prompt);
        addField('n', '1');
        addField('size', '1024x1024');

        const imgHeader =
          `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="image"; filename="image.png"${CRLF}` +
          `Content-Type: image/png${CRLF}${CRLF}`;

        const closing = `${CRLF}--${boundary}--${CRLF}`;

        const headerBuf  = Buffer.from(parts.join('') + imgHeader, 'utf8');
        const closingBuf = Buffer.from(closing, 'utf8');
        const formData   = Buffer.concat([headerBuf, imgBuffer, closingBuf]);

        const editOpts = {
          hostname: 'api.openai.com',
          path: '/v1/images/edits',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${OPENAI_KEY}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': formData.length
          }
        };

        const editReq = https.request(editOpts, editRes => {
          const resBufs = [];
          editRes.on('data', c => resBufs.push(c));
          editRes.on('end', () => {
            const raw = Buffer.concat(resBufs).toString();
            console.log('[transform] status:', editRes.statusCode);
            console.log('[transform] response:', raw.slice(0, 500));
            try {
              const parsed = JSON.parse(raw);
              if (parsed.error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: parsed.error.message || JSON.stringify(parsed.error) }));
                return;
              }
              const item = parsed.data && parsed.data[0];
              if (!item) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No image in response: ' + raw.slice(0, 200) }));
                return;
              }
              const b64 = item.b64_json || null;
              const url = item.url || null;
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ imageBase64: b64, imageUrl: url }));
            } catch(e) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Parse error: ' + e.message + ' | raw: ' + raw.slice(0, 200) }));
            }
          });
        });
        editReq.on('error', e => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        });
        editReq.write(formData);
        editReq.end();

      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad request: ' + e.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && /\.(png|jpg|jpeg|webp)$/i.test(req.url)) {
    const imgPath = path.join(__dirname, decodeURIComponent(req.url.split('?')[0]));
    if (fs.existsSync(imgPath)) {
      const ext = path.extname(imgPath).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
      res.writeHead(200, { 'Content-Type': mime });
      fs.createReadStream(imgPath).pipe(res);
    } else {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/analyze') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { imageBase64, mimeType } = JSON.parse(body);

        const payload = JSON.stringify({
          model: 'claude-opus-4-5',
          max_tokens: 600,
          system: `You are an expert at analyzing facial structure and determining face shape.
Examine the photo carefully — look at jawline width, forehead width, cheekbone prominence, face length vs width, and overall silhouette.

Return ONLY this JSON, no markdown:
{
  "shape": "One of: Oval, Square, Round, Oblong, Rectangular, Diamond, Heart, Triangle",
  "confidence": 85,
  "certain": true,
  "reasoning": "2-3 sentences citing specific proportions — forehead vs jaw width, cheekbone prominence, face length vs width.",
  "secondary": "Second most likely shape if confidence below 80, otherwise null"
}

If the face is not clearly visible or the angle is bad, set certain to false and shape to null.`,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: imageBase64 } },
              { type: 'text', text: 'Analyze this face and return the JSON.' }
            ]
          }]
        });

        const options = {
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(payload)
          }
        };

        const apiReq = https.request(options, apiRes => {
          let data = '';
          apiRes.on('data', chunk => data += chunk);
          apiRes.on('end', () => {
            res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(data);
          });
        });

        apiReq.on('error', err => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });

        apiReq.write(payload);
        apiReq.end();

      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/analyze-brow') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { imageBase64, mimeType } = JSON.parse(body);

        const payload = JSON.stringify({
          model: 'claude-opus-4-5',
          max_tokens: 1600,
          system: `You are an expert facial analyst specializing in eye morphology and eyebrow aesthetics for men.

STEP 1 — MEASURE these features from the photo:

CANTHAL TILT: Angle between medial canthus (inner corner) and lateral canthus (outer corner) vs horizontal.
- Strong Negative: <-5° | Negative: -5° to -2° | Neutral: -2° to +2° | Positive: +2° to +5° | Strong Positive: >+5°

EYEBROW DISTANCE RATIO: Distance between bottom of brow and top of upper eyelid ÷ visible eye height.
- Low Set: <1.2 | Medium: 1.2–1.8 | High Set: >1.8

BROW DENSITY: % of brow area covered by hair.
- Sparse: <50% (score 1–4) | Average: 50–75% (score 5–7) | Dense: >75% (score 8–10)

BROW SYMMETRY: Symmetry Score = 100 − avg % difference in height/length/thickness/arch/tail.
- Elite: 90–100 | Good: 80–89 | Average: 70–79 | Weak: <70

CURRENT BROW SHAPE: Straight Brow | Straight Brow With Slight Arch | Rounded Brow | Moderate Arch | High Arch

FACE SHAPE: Oval | Square | Round | Rectangular | Oblong | Diamond | Heart | Triangle

JAW STRENGTH: Strong | Moderate | Weak (based on jaw width and definition)

EYE SHAPE: Deep-set | Normal | Prominent | Downturned | Almond

STEP 2 — SCORE all 5 brow archetypes using these exact rules:

TYPE A — Straight Masculine Brow:
+3 Positive or Strong Positive canthal tilt
+2 Strong jawline
+2 Square face
+2 Rectangular face
+1 Deep-set eyes
+1 Dense brows
-3 Negative or Strong Negative canthal tilt
-2 Heart face
-2 High Set brow-eye distance
→ Recommend if score ≥ 6

TYPE B — Straight Brow With Slight Arch:
+2 Oval face
+2 Diamond face
+2 Positive canthal tilt
+1 Medium brow-eye distance
+1 Moderate jawline
-2 Very round face
→ Recommend if score ≥ 5

TYPE C — Natural Soft Arch:
+3 Heart face
+2 Round face
+2 Neutral canthal tilt
+1 High Set brow-eye distance
-2 Strong jawline
→ Recommend if score ≥ 5

TYPE D — Moderate Arch:
+3 Negative or Strong Negative canthal tilt
+2 Downturned eyes
+1 High Set brow-eye distance
-3 Positive or Strong Positive canthal tilt
→ Recommend if score ≥ 5

TYPE E — Full Natural Brow:
+3 Elite symmetry (90–100)
+2 Dense brows
+2 Good symmetry (80–89)
+2 Positive canthal tilt
-2 Sparse brows
→ Recommend if score ≥ 6

STEP 3 — Select the highest scoring archetype as the winner.
STEP 4 — Confidence = (winning score ÷ sum of all positive points scored across all types) × 100. Round to nearest integer.

STEP 5 — SCORE THESE 6 EYEBROW TRAITS (each 1–10, one decimal):

eyebrowFraming (20%): Holistic score — how much the brows enhance the eye area considering density+position+shape+length together. 9–10=elite framing. 7–8=strong. 5–6=average. 3–4=below average. 1–2=weak framing.
eyebrowShape (20%): Ideal male shape = mostly straight, slight natural arch, sharp tail, not overly rounded. 9–10=elite masculine. 7–8=strong. 5–6=average. 3–4=weak. 1–2=poor.
eyebrowPosition (20%): Distance from brow to upper eyelid — closer = stronger framing. 9–10=elite close set. 7–8=close. 5–6=average. 3–4=high set. 1–2=very high set.
eyebrowThickness (15%): Visual hair volume and boldness. 9–10=elite masculine brow. 7–8=thick. 5–6=average. 3–4=thin. 1–2=very thin.
eyebrowDensity (15%): How tightly packed hairs are, visible skin gaps. 9–10=extremely dense. 7–8=dense. 5–6=average. 3–4=sparse. 1–2=very sparse.
eyebrowLength (10%): Eye width coverage — ideal extends slightly past outer corner. 9–10=elite. 7–8=good. 5–6=average. 3–4=short. 1–2=very short.

eyebrowScore = (Framing×0.20)+(Shape×0.20)+(Position×0.20)+(Thickness×0.15)+(Density×0.15)+(Length×0.10)
Round to one decimal. Use as overallScore.

STEP 6 — POTENTIAL: Do not calculate. Omit eyebrowPotential and eyebrowPotentialGain from the response — these are computed client-side.

Potential Classification: 9.5–10.0="Elite Potential", 8.5–9.4="High Potential", 7.5–8.4="Moderate Potential", below 7.5="Limited Potential".

Write overallDescription: 3–4 sentences, SPECIFIC to what you observed. Name actual traits. Sound like a real aesthetics expert studying this exact face. NO generic statements.
List primaryImprovementSources: top 1–3 specific improvement actions.

Return ONLY this JSON, no markdown:
{
  "canthalTilt": {
    "angle": 4.3,
    "classification": "Positive",
    "confidence": 85,
    "description": "1 sentence about what this means for brow selection"
  },
  "browDistance": {
    "ratio": 1.4,
    "value": "Medium",
    "description": "1 sentence"
  },
  "browDensity": {
    "score": 7,
    "classification": "Dense",
    "subLabel": "No growth needed",
    "description": "1 sentence"
  },
  "browSymmetry": {
    "score": 85,
    "classification": "Good",
    "notes": "1 sentence"
  },
  "browShape": {
    "current": "Rounded Brow",
    "currentConfidence": 88
  },
  "archetypeScores": {
    "straightMasculine": 10,
    "straightSlightArch": 6,
    "naturalSoftArch": 2,
    "moderateArch": 0,
    "fullNatural": 5
  },
  "idealBrowType": "Straight Masculine Brow",
  "idealBrowTypeKey": "straightMasculine",
  "idealConfidence": 87,
  "idealBrowReasons": ["Positive canthal tilt (+4.3°)", "Strong jawline", "Square face shape", "Dense brow growth"],
  "eyebrowTraits": {
    "eyebrowFraming": 7.5,
    "eyebrowShape": 7.0,
    "eyebrowPosition": 8.0,
    "eyebrowThickness": 7.5,
    "eyebrowDensity": 6.0,
    "eyebrowLength": 6.5,
    "eyebrowScore": 7.1
  },
  "categoryScores": {
    "shape": 7.5,
    "symmetry": 8.0,
    "density": 7.0,
    "thickness": 6.5,
    "browEyeHarmony": 8.5,
    "grooming": 7.0,
    "masculinity": 8.0
  },
  "overallScore": 7.1,
  "overallDescription": "3-4 sentences: specific to what you observed. Mention actual trait names and scores. Sound like a real aesthetics expert.",
  "potentialScore": 9.0,
  "potentialClassification": "High Potential",
  "improvementGain": 1.9,
  "primaryImprovementSources": ["Straighter brow shape", "Increased density", "Better grooming"],
  "changes": {
    "remove": ["item 1", "item 2"],
    "keep": ["item 1", "item 2"],
    "grow": ["item 1"],
    "avoid": ["item 1", "item 2", "item 3"]
  },
  "actionPlan": ["Step 1", "Step 2", "Step 3"],
  "certain": true
}

If face/eyes not clearly visible, set certain to false.`,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: imageBase64 } },
              { type: 'text', text: 'Analyze the eyebrows and canthal tilt in this photo and return the JSON.' }
            ]
          }]
        });

        const options = {
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(payload)
          }
        };

        const apiReq = https.request(options, apiRes => {
          let data = '';
          apiRes.on('data', chunk => data += chunk);
          apiRes.on('end', () => {
            res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(data);
          });
        });

        apiReq.on('error', err => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });

        apiReq.write(payload);
        apiReq.end();

      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/analyze-eye') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { imageBase64, mimeType } = JSON.parse(body);

        const payload = JSON.stringify({
          model: 'claude-opus-4-5',
          max_tokens: 800,
          system: `You are an expert in male facial aesthetics scoring eye attractiveness. Do NOT inflate scores.

SCORE DISTRIBUTION — follow strictly:
Bottom 10%: 0–3 | Bottom 30%: 3–5 | Average person: 5–6 | Top 30%: 6–8 | Top 10%: 8–9 | Top 1%: 9–10
Most people score 5–6.5. Above 8 is uncommon. Above 9 is extremely rare.

Score these 7 traits from 1–10:

1. CANTHAL TILT (20%): Angle between inner and outer eye corner.
1-2 Strong negative tilt | 3-4 Negative tilt | 5-6 Neutral | 7-8 Positive tilt | 9-10 Elite positive tilt

2. EYE SHAPE (20%): Overall shape — almond ideal, horizontal orientation, balanced.
1-2 Poor shape | 3-4 Weak shape | 5-6 Average | 7-8 Strong shape | 9-10 Elite almond shape

3. EYE EXPOSURE (15%): How compact/protected the eyes appear. Less scleral show = higher.
1-2 Very exposed | 3-4 Exposed | 5-6 Average | 7-8 Good exposure | 9-10 Elite compact

4. UPPER EYELID EXPOSURE (15%): Visible eyelid space above iris. Less visible = stronger hunter eyes.
1-2 Very high exposure | 3-4 High exposure | 5-6 Average | 7-8 Low exposure | 9-10 Elite low exposure

5. EYE DEPTH (10%): How deep-set the eyes appear. Deep-set = stronger structure.
1-2 Very protruding | 3-4 Protruding | 5-6 Average | 7-8 Deep-set | 9-10 Elite depth

6. EYE SPACING (10%): Distance between eyes — ideal ≈ 1 eye-width gap.
1-2 Very poor spacing | 3-4 Poor spacing | 5-6 Average | 7-8 Good spacing | 9-10 Elite spacing

7. EYE SYMMETRY (10%): Left/right similarity.
1-2 Very asymmetrical | 3-4 Noticeably asymmetrical | 5-6 Average | 7-8 Strong symmetry | 9-10 Near perfect symmetry

OVERALL EYE SCORE:
eyeScore = (canthalTilt×0.20)+(eyeShape×0.20)+(eyeExposure×0.15)+(upperEyelidExposure×0.15)+(eyeDepth×0.10)+(eyeSpacing×0.10)+(eyeSymmetry×0.10)
Round to one decimal.

SUPPLEMENTAL VALUES (for potential calculation only — do not include in eye score):

underEyeScore: Evaluate dark circles, tear trough hollowing, puffiness/bags, and overall brightness.
9–10=bright under-eye, no hollows, no darkness, no puffiness.
7–8=minor darkness/hollowing, generally healthy.
5–6=noticeable darkness, moderate hollowing, moderate puffiness.
3–4=significant darkness, significant hollows, visible bags.
1–2=severe darkness, severe hollows, severe puffiness.

eyeContrast: How striking the eyes appear — evaluate eye color visibility, eye color intensity, contrast against skin, contrast against eyebrows, contrast against hair.
9–10=extremely striking eye color, naturally high contrast, eyes immediately stand out (bright blue, bright green, exceptional contrast).
7–8=strong eye color, good visibility, above-average contrast.
5–6=average eye color, average visibility, moderate contrast.
3–4=weak eye visibility, low contrast, eyes do not stand out.
1–2=very low contrast, eyes blend heavily into surrounding features.

Do NOT calculate potential. Omit eyePotential and eyePotentialGain — computed client-side.

Return ONLY this JSON, no markdown:
{
  "eyeScore": 7.8,
  "canthalTilt": 8.7,
  "eyeShape": 8.0,
  "eyeExposure": 7.5,
  "upperEyelidExposure": 8.0,
  "eyeDepth": 7.0,
  "eyeSpacing": 7.8,
  "eyeSymmetry": 7.6,
  "underEyeScore": 6.5,
  "eyeContrast": 5.0,
  "overallScore": 7.8,
  "certain": true
}

If eyes not clearly visible, set certain to false.`,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: imageBase64 } },
              { type: 'text', text: 'Analyze the eyes in this photo and return the JSON.' }
            ]
          }]
        });

        const options = {
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(payload)
          }
        };

        const apiReq = https.request(options, apiRes => {
          let data = '';
          apiRes.on('data', chunk => data += chunk);
          apiRes.on('end', () => {
            res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(data);
          });
        });
        apiReq.on('error', err => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
        apiReq.write(payload);
        apiReq.end();

      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── Eye insight personalized text ──
  if (req.method === 'POST' && req.url === '/api/eye-insight') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const d = JSON.parse(body);
        const prompt = `You are a facial aesthetics expert writing a personalized eye analysis report. Be direct and specific — reference the actual scores and traits. Do not use filler language. Do not be generic.

Eye trait scores (1-10):
Canthal Tilt: ${d.canthalTilt ?? '—'}
Eye Exposure: ${d.eyeExposure ?? '—'}
Upper Eyelid Exposure: ${d.upperEyelidExposure ?? '—'}
Under Eye Support: ${d.underEyeSupport ?? '—'}
Eyebrow Position: ${d.eyeBrowDistance ?? '—'}
Eye Shape: ${d.eyeShape ?? '—'}
Eye Symmetry: ${d.eyeSymmetry ?? '—'}
Eye Spacing: ${d.eyeSpacing ?? '—'}
Scleral Show: ${d.scleralShow ?? '—'}
Eye Depth: ${d.eyeDepth ?? '—'}
Eye Color Contrast: ${d.eyeContrast ?? '—'}
Eyelash Quality: ${d.eyelashQuality ?? '—'}
Eye Area Harmony: ${d.eyeHarmony ?? '—'}

Overall Eye Score: ${d.eyeScore ?? '—'} / 10
Potential Score: ${d.eyePotential ?? '—'} / 10
Strongest Feature: ${d.eyeStrongestFactor ?? '—'}
Biggest Weakness: ${d.eyeWeakestFactor ?? '—'}

Write 4 sections. Each 2-4 sentences. Reference specific traits by name. Be honest about weaknesses.

Return ONLY this JSON, no markdown:
{
  "whyThisScore": "Explain exactly why the eye area scores what it does. Name the strong traits that raise it and the weak traits that limit it.",
  "whatHappensIfNothing": "What stays limited about the eye area if nothing changes. Be specific about which traits are holding back the score.",
  "idealEyeArea": "Describe what this specific person's eye area looks like when all improvable traits are optimized.",
  "potentialExplainer": "Explain what drives the potential gain. Name which traits are improvable and how much visual difference that makes."
}`;

        const payload = JSON.stringify({
          model: 'claude-opus-4-5',
          max_tokens: 900,
          messages: [{ role: 'user', content: prompt }]
        });

        const options = {
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(payload)
          }
        };
        const apiReq = https.request(options, apiRes => {
          let data = '';
          apiRes.on('data', chunk => data += chunk);
          apiRes.on('end', () => {
            res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(data);
          });
        });
        apiReq.on('error', err => {
          res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
        });
        apiReq.write(payload);
        apiReq.end();
      } catch (err) {
        res.writeHead(400); res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── Skin insight personalized text ──
  if (req.method === 'POST' && req.url === '/api/skin-insight') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const d = JSON.parse(body);
        const prompt = `You are a dermatology and facial aesthetics expert writing a personalized skin analysis report. Be direct and specific — reference actual scores and traits by name. No filler. Every sentence must be specific to the exact values provided.

Skin trait scores (1–10):
Acne/Scars/Marks: ${d.acneScore ?? '—'} | Texture: ${d.textureScore ?? '—'} | Clarity: ${d.clarityScore ?? '—'}
Redness: ${d.rednessScore ?? '—'} | Pores: ${d.poreScore ?? '—'} | Oil Balance: ${d.oilBalance ?? '—'} | Hydration: ${d.hydrationScore ?? '—'}
Tone Evenness: ${d.toneEvenness ?? '—'} | Under Eyes: ${d.underEyeSkin ?? '—'} | Glow: ${d.skinGlow ?? '—'} | Sun Damage: ${d.sunDamage ?? '—'}
Hyperpigmentation: ${d.hyperpigmentation ?? '—'} | Firmness: ${d.skinFirmness ?? '—'} | Facial Contrast: ${d.facialContrast ?? '—'} | Harmony: ${d.skinHarmony ?? '—'}

Overall Skin Score: ${d.skinScore ?? '—'} / 10
Potential Score: ${d.skinPotential ?? '—'} / 10
Strongest Factor: ${d.skinStrongestFactor ?? '—'}
Biggest Weakness: ${d.skinWeakestFactor ?? '—'}

Write 4 sections. Each 2–4 sentences. Reference specific trait names and scores. Be honest about weaknesses.

Return ONLY this JSON, no markdown:
{
  "whyThisScore": "Explain exactly why the skin scores what it does. Name the 2–3 traits with highest scores and the 2–3 traits limiting the score. Be specific — mention numbers.",
  "whatHappensIfNothing": "Which specific traits will continue holding back the skin score if nothing changes. Be direct and concrete.",
  "idealSkin": "Describe what this specific person's skin looks like when all improvable traits are optimized. Reference their starting point.",
  "potentialExplainer": "Explain what drives the potential gain. Name which traits are most improvable and what that visual difference looks like."
}`;

        const payload = JSON.stringify({
          model: 'claude-opus-4-5',
          max_tokens: 900,
          messages: [{ role: 'user', content: prompt }]
        });

        const options = {
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(payload)
          }
        };
        const apiReq = https.request(options, apiRes => {
          let data = '';
          apiRes.on('data', chunk => data += chunk);
          apiRes.on('end', () => {
            res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(data);
          });
        });
        apiReq.on('error', err => { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); });
        apiReq.write(payload); apiReq.end();
      } catch(err) { res.writeHead(400); res.end(JSON.stringify({ error: err.message })); }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/analyze-skin') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { imageBase64, mimeType } = JSON.parse(body);

        const payload = JSON.stringify({
          model: 'claude-opus-4-5',
          max_tokens: 700,
          system: `You are a cosmetic appearance analyst. This is NOT medical diagnosis. Score visible skin appearance only.

PHOTO QUALITY CHECK (do this first):
If lighting is bad, face is blurry, heavy filter detected, or skin is covered by makeup/editing → skinAnalysisConfidence = "low"
If lighting is clear and face is sharp → skinAnalysisConfidence = "high"

Score these 8 metrics 1–10. Be specific. Do not be vague.

1. acneScore — ALL acne-related damage combined: active acne, scarring, post-acne marks, acne-related texture damage. Score the overall acne damage picture, not individual components:
10=completely clear, no acne, no scars, no marks | 9=almost completely clear, very minor | 8=minor acne or minor leftover marks | 7=noticeable acne or noticeable old marks | 6=moderate acne and/or moderate scarring | 5=significant acne and/or significant scarring | 4=heavy acne and/or heavy scarring | 3=very heavy acne damage | 2=severe acne damage | 1=extreme acne damage

2. textureScore — skin smoothness (bumps, roughness, uneven surface, visible pores):
10=extremely smooth | 9=very smooth | 8=smooth | 7=slightly uneven | 6=average | 5=noticeable unevenness | 4=rough | 3=very rough | 2=severe | 1=extremely rough

4. clarityScore — overall visual cleanliness (blemishes, spots, cloudiness, general cleanliness):
10=crystal clear | 9=very clear | 8=clear | 7=mostly clear | 6=average | 5=somewhat unclear | 4=poor | 3=very poor | 2=severe | 1=extremely unclear

5. rednessScore — visible redness/irritation (red patches, inflamed areas, uneven red tone). HIGH = LESS redness:
10=none | 9=almost none | 8=minimal | 7=mild | 6=average | 5=noticeable | 4=strong | 3=very strong | 2=severe | 1=extreme

6. hydrationScore — healthy, hydrated appearance (dryness, flakiness, tightness, plumpness):
10=very hydrated | 9=strongly hydrated | 8=hydrated | 7=slightly above avg | 6=average | 5=slightly dry | 4=dry | 3=very dry | 2=severely dry | 1=extremely dry

7. toneEvenness — even skin color (uneven patches, dark spots, hyperpigmentation, color inconsistency):
10=perfectly even | 9=very even | 8=even | 7=slightly uneven | 6=average | 5=noticeable unevenness | 4=uneven | 3=very uneven | 2=severely uneven | 1=extremely uneven

8. skinGlow — healthy visual vibrancy (brightness, freshness, dullness):
10=elite glow | 9=very strong | 8=healthy glow | 7=good | 6=average | 5=slightly dull | 4=dull | 3=very dull | 2=unhealthy dullness | 1=extremely dull

9. tanScore — skin darkness relative to ethnicity, healthy bronzed appearance, facial contrast created by skin tone:
10=elite natural tan, highly attractive | 9=strong tan | 8=good tan | 7=slightly tanned | 6=neutral skin tone | 5=slightly pale | 4=pale | 3=very pale | 2=extremely pale | 1=extremely washed out

OVERALL SCORE:
skinScore = (acneScore×0.25)+(textureScore×0.15)+(clarityScore×0.15)+(rednessScore×0.10)+(hydrationScore×0.10)+(toneEvenness×0.10)+(skinGlow×0.08)+(tanScore×0.07)
Round to 1 decimal.
scoreLabel: 9+"Exceptional" | 8+"Excellent" | 7+"Good" | 6+"Above Average" | 5+"Average" | below 5="Below Average"

BIGGEST SKIN STRENGTH:
From ONLY these 6: clarityScore, tanScore, textureScore, skinGlow, toneEvenness, hydrationScore
biggestSkinStrength = key name of the highest among those 6.
Tiebreaker order: clarityScore → tanScore → textureScore → skinGlow → toneEvenness → hydrationScore
Do NOT use acneScore or rednessScore as biggestSkinStrength.

POTENTIAL:
skinPotential = realistic score via consistent skincare + lifestyle. Cap 10.0.
skinPotentialGain = skinPotential − skinScore, rounded to 1 decimal.

Do NOT compute skinPotential or skinPotentialGain — those are computed client-side.

Return ONLY this JSON, no markdown:
{
  "acneScore": 8.2, "textureScore": 6.8, "clarityScore": 7.1,
  "rednessScore": 8.0, "hydrationScore": 6.9, "toneEvenness": 7.4, "skinGlow": 7.0,
  "tanScore": 7.5,
  "skinScore": 7.4, "overallScore": 7.4, "scoreLabel": "Good",
  "biggestSkinStrength": "tanScore",
  "skinAnalysisConfidence": "high", "certain": true
}

If skin is not clearly visible, set certain to false.`,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: imageBase64 } },
              { type: 'text', text: 'Analyze the skin quality in this photo and return the JSON.' }
            ]
          }]
        });

        const options = {
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(payload)
          }
        };

        const apiReq = https.request(options, apiRes => {
          let data = '';
          apiRes.on('data', chunk => data += chunk);
          apiRes.on('end', () => {
            res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(data);
          });
        });
        apiReq.on('error', err => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
        apiReq.write(payload);
        apiReq.end();

      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── Hair analysis endpoint ──
  if (req.method === 'POST' && req.url === '/api/analyze-hair') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { imageBase64, mimeType } = JSON.parse(body);

        const payload = JSON.stringify({
          model: 'claude-opus-4-5',
          max_tokens: 800,
          system: `You are an expert hair analyst and stylist. Analyze the person's hair and face in this photo.

STEP 1 — HAIR TYPE:
Classify hair type as one of: 1A, 1B, 1C, 2A, 2B, 2C, 3A, 3B, 3C, 4A, 4B, 4C
If hair is too short to determine curl pattern accurately, use "Unable To Determine".
Also assess:
- hairDensity: "Low" | "Medium" | "High"
- hairThickness: "Fine" | "Medium" | "Thick"
- hairlineQuality: "Strong" | "Average" | "Receding"
- currentLength: brief description e.g. "Short", "Medium", "Long"

STEP 2 — FACE SHAPE:
Classify as: Oval | Round | Square | Rectangle | Heart | Diamond

STEP 3 — IDEAL HAIRCUT (ONE only, based on this exact lookup):
OVAL:    1A→Textured Middle Part, 1B→Modern Side Part, 1C→Textured Fringe, 2A→Flow, 2B→Curtains, 2C→Wavy Curtains, 3A→Curly Flow, 3B→Curly Fringe, 3C→Curly Taper, 4A→Twists, 4B→Tapered Twists, 4C→Textured Taper Fade
ROUND:   1A→Textured Quiff, 1B→Modern Quiff, 1C→High Volume Quiff, 2A→Wavy Quiff, 2B→Wavy Side Part, 2C→Wavy Pompadour, 3A→Curly Quiff, 3B→Curly High Top, 3C→Curly Taper Fade, 4A→High Top Fade, 4B→Structured High Top, 4C→High Taper Fade
SQUARE:  1A→Ivy League, 1B→Classic Side Part, 1C→Textured Crop, 2A→Flow, 2B→Wavy Fringe, 2C→Layered Flow, 3A→Curly Crop, 3B→Curly Fringe, 3C→Short Curly Top, 4A→Taper Fade, 4B→Twists, 4C→Short Textured Afro
RECTANGLE: 1A→French Crop, 1B→Side Swept Fringe, 1C→Textured Fringe, 2A→Wavy Fringe, 2B→Curtains, 2C→Medium Wavy Fringe, 3A→Curly Fringe, 3B→Curly Crop, 3C→Medium Curly Fringe, 4A→Short Twists, 4B→Coils, 4C→Short Afro
HEART:   1A→Side Part, 1B→Textured Side Part, 1C→Layered Fringe, 2A→Flow, 2B→Curtains, 2C→Wavy Curtains, 3A→Curly Curtains, 3B→Curly Fringe, 3C→Curly Flow, 4A→Twists, 4B→Medium Twists, 4C→Taper Fade
DIAMOND: 1A→Textured Fringe, 1B→Side Part, 1C→Layered Fringe, 2A→Flow, 2B→Curtains, 2C→Wavy Curtains, 3A→Curly Flow, 3B→Curly Fringe, 3C→Curly Curtains, 4A→Twists, 4B→Coils, 4C→Taper Fade

If hairType is "Unable To Determine", choose the best haircut based on face shape alone using the 1A row as default.

STEP 4 — HAIR SCORE:
Score current hair aesthetics from 1–10 based on: density (low density = lower score), thickness (fine = lower), hairline quality (receding = lower), cleanliness/health, and how well current style suits the face shape. Average hair = 5–6, excellent = 8–9, elite = 9.5+.
hairPotential = the score achievable with the ideal haircut and basic hair care. Always at least 0.5 higher than hairScore.

STEP 5 — HAIRCUT FIT SCORE:
Detect the current haircut style from the photo. Then score it against the face shape goal. Start at 5.

FACE SHAPE GOALS AND CATEGORIES:
OVAL: Goal=maintain balance. GOOD(+3)=Curtains,Flow,Middle Part,Textured Fringe. BAD(-3)=Extreme Mohawk,Extremely Tall/Wide styles.
ROUND: Goal=create height/verticality. GOOD(+3)=Quiff,Pompadour,High Volume Textured. BAD(-3)=Buzz Cut,Bowl Cut.
SQUARE: Goal=complement jawline, allow softness. GOOD(+3)=Flow,Textured Crop,Curly Fringe,Side Part. BAD(-3)=Flat Tops,Extremely Boxy styles.
RECTANGLE: Goal=reduce length, add width. GOOD(+3)=Curtains,Fringe,Curly Fringe,Medium Flow. BAD(-3)=Quiff,Pompadour,High Volume styles.
HEART: Goal=balance wider forehead, avoid top volume. GOOD(+3)=Curtains,Flow,Medium Length. BAD(-3)=Tall Quiffs,Large Pompadours.
DIAMOND: Goal=support cheekbones, create width at temples. GOOD(+3)=Curtains,Flow,Fringe,Medium Length. BAD(-3)=Very Short styles,Very High Fades.

BONUSES/PENALTIES:
Face shape bonus: +3 if current haircut is GOOD for this face shape, 0 if neutral, -3 if BAD.
Hair type bonus: +2 if current haircut works naturally with the detected hair type (e.g., flow/curtains with wavy hair), 0 if neutral, -2 if it fights the hair type.
Thickness bonus: +1 if current haircut takes advantage of hair thickness, 0 if neutral, -1 if it wastes it.

haircutFitScore = 5 + face_shape_bonus + hair_type_bonus + thickness_bonus. Clamp 1–10.

Return ONLY this JSON, no markdown:
{
  "hairType": "2B",
  "hairDensity": "High",
  "hairThickness": "Medium",
  "hairlineQuality": "Strong",
  "currentLength": "Medium",
  "currentHaircutStyle": "Curtains",
  "faceShape": "Oval",
  "idealHaircut": "Curtains",
  "whyItWorks": "2-4 sentences explaining why this specific haircut works for this person's exact face shape and hair type combination.",
  "hairScore": 7.2,
  "hairPotential": 8.5,
  "haircutFitScore": 8,
  "certain": true
}

If hair is not visible or the photo angle makes analysis impossible, set certain to false.`,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: imageBase64 } },
              { type: 'text', text: 'Analyze the hair and face in this photo and return the JSON.' }
            ]
          }]
        });

        const options = {
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(payload)
          }
        };

        const apiReq = https.request(options, apiRes => {
          let data = '';
          apiRes.on('data', chunk => data += chunk);
          apiRes.on('end', () => {
            res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(data);
          });
        });
        apiReq.on('error', err => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
        apiReq.write(payload);
        apiReq.end();

      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── Hair insight personalized text ──
  if (req.method === 'POST' && req.url === '/api/hair-insight') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { hairType, faceShape, haircut, density, thickness, hairline } = JSON.parse(body);

        const payload = JSON.stringify({
          model: 'claude-opus-4-5',
          max_tokens: 900,
          system: `You are a world-class hair stylist and facial analyst. You write brutally honest, highly specific, personalized analysis for men. Your writing is direct, confident, and data-driven. No filler. No generic advice. Every sentence must be specific to the exact values provided.`,
          messages: [{
            role: 'user',
            content: `Write a personalized hair analysis for someone with the following profile:
- Face Shape: ${faceShape}
- Hair Type: ${hairType}
- Hair Density: ${density}
- Hair Thickness: ${thickness}
- Hairline Quality: ${hairline}
- Recommended Haircut: ${haircut}

Return ONLY this JSON (no markdown, no code fences):
{
  "faceShapeAnalysis": "2-3 sentences. Explain what ${faceShape} face shape means structurally. What are the proportions. What does a good haircut need to do for this shape.",
  "hairAnalysis": "2-3 sentences. Explain exactly what ${hairType} hair with ${density} density and ${thickness} thickness means. Why these traits matter for choosing a haircut. Be specific about the wave/curl/straight pattern implications.",
  "whyCutWins": "3-4 sentences. Explain exactly why ${haircut} beats every other option for the exact combo of ${faceShape} + ${hairType} + ${density} density + ${thickness} + ${hairline} hairline. Name 1-2 alternative cuts and explain precisely why they lose to ${haircut} for this combination.",
  "currentHairWarning": "3-4 sentences. Explain what someone with ${faceShape} face and ${hairType} hair is likely doing wrong with a generic/default haircut. What specific advantages they are missing. What improves by switching to ${haircut}. Be concrete — mention framing, eye emphasis, facial harmony, wave pattern utilization.",
  "bulletPoints": ["${faceShape} Face Shape", "${hairType} Hair", "${density} Density", "${thickness} Thickness", "${hairline} Hairline"]
}`
          }]
        });

        const options = {
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(payload)
          }
        };

        const apiReq = https.request(options, apiRes => {
          let data = '';
          apiRes.on('data', chunk => data += chunk);
          apiRes.on('end', () => {
            res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(data);
          });
        });
        apiReq.on('error', err => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
        apiReq.write(payload);
        apiReq.end();

      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── Brow insight narrative generator ──
  if (req.method === 'POST' && req.url === '/api/brow-insight') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const d = JSON.parse(body);
        const payload = JSON.stringify({
          model: 'claude-opus-4-5',
          max_tokens: 700,
          system: `You are a world-class facial aesthetics consultant. You write brutally honest, specific, personalized analysis. Every sentence must reference the actual numbers provided. No generic statements. Sound like an expert who studied their specific face.`,
          messages: [{
            role: 'user',
            content: `Write a personalized eyebrow analysis for these exact scores (1–10):
Thickness: ${d.eyebrowThickness}, Density: ${d.eyebrowDensity}, Darkness: ${d.eyebrowDarkness}, Shape: ${d.eyebrowShape}, Length: ${d.eyebrowLength}, Position: ${d.eyebrowPosition}, Symmetry: ${d.eyebrowSymmetry}, Tail: ${d.eyebrowTail}, Grooming: ${d.eyebrowGrooming}, Straightness: ${d.eyebrowStraightness}, Arch: ${d.eyebrowArch}, Framing: ${d.eyebrowFraming}
Overall Score: ${d.overall} | Potential: ${d.potential}

Return ONLY this JSON (no markdown):
{
  "whyThisScore": "4-5 sentences. Explain WHY this person scores ${d.overall}/10 using all 12 traits. Name the 2 strongest and 2 weakest by actual score. Be specific — mention numbers. Sound like a real aesthetics expert.",
  "whatHappensIfNothing": "3-4 sentences. Name the specific traits that will keep holding this person back if nothing changes. Be direct. No fluff.",
  "idealEyebrows": "3 sentences. Describe exactly what their ideal brows look like — what stays (strong traits), what changes (weak traits), and the final visual effect on their face and eye area."
}`
          }]
        });
        const options = {
          hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(payload) }
        };
        const apiReq = https.request(options, apiRes => {
          let data = '';
          apiRes.on('data', c => data += c);
          apiRes.on('end', () => { res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(data); });
        });
        apiReq.on('error', err => { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); });
        apiReq.write(payload); apiReq.end();
      } catch(err) { res.writeHead(400); res.end(JSON.stringify({ error: err.message })); }
    });
    return;
  }

  // ── Eye detection endpoint ──
  if (req.method === 'GET' && req.url === '/api/eye-positions') {
    const { execSync } = require('child_process');
    const imgPath = path.join(__dirname, 'face.jpg');
    try {
      const py = `
import cv2, json, sys
img = cv2.imread(r'${imgPath.replace(/\\/g, '\\\\')}')
if img is None: sys.exit(1)
h, w = img.shape[:2]
gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
eye_c = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_eye.xml')
eyes = eye_c.detectMultiScale(gray, 1.1, 10)
result = []
for (ex,ey,ew,eh) in eyes:
    result.append({'x': int(ex+ew//2), 'y': int(ey+eh//2), 'r': int(ew//2)})
result.sort(key=lambda e: e['x'])
print(json.dumps({'eyes': result[:2], 'imgW': w, 'imgH': h}))
`;
      const out = execSync(`python3 -c "${py.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`).toString().trim();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(out);
    } catch (e) {
      // Fallback to known-good positions from pixel analysis
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ eyes: [{x:155,y:170,r:23},{x:236,y:167,r:23}], imgW:400, imgH:400 }));
    }
    return;
  }

  // ── Serve tasks.html ──
  if (req.method === 'GET' && req.url.startsWith('/tasks')) {
    const html = fs.readFileSync(path.join(__dirname, 'tasks.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  // ── Serve improve.html ──
  if (req.method === 'GET' && req.url.startsWith('/improve')) {
    const html = fs.readFileSync(path.join(__dirname, 'improve.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  // ── Serve dashboard.html ──
  if (req.method === 'GET' && (req.url === '/dashboard' || req.url === '/dashboard.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  // ── Serve brow-overlay.html ──
  if (req.method === 'GET' && req.url === '/brow') {
    const html = fs.readFileSync(path.join(__dirname, 'brow-overlay.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  // ── Serve transform.html ──
  if (req.method === 'GET' && req.url === '/transform') {
    const html = fs.readFileSync(path.join(__dirname, 'transform.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  // ── Generate 3-Month Plan via Claude ──
  if (req.method === 'POST' && req.url === '/api/generate-plan') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { analysisData } = JSON.parse(body);

        // Build a readable summary of whatever analysis we have
        let analysisSummary = '';
        if (analysisData.faceResults) analysisSummary += `Face shape analysis: ${JSON.stringify(analysisData.faceResults)}\n`;
        if (analysisData.browResults) analysisSummary += `Brow analysis: ${JSON.stringify(analysisData.browResults)}\n`;
        if (analysisData.eyeResults)  analysisSummary += `Eye analysis: ${JSON.stringify(analysisData.eyeResults)}\n`;
        if (analysisData.skinResults) analysisSummary += `Skin analysis: ${JSON.stringify(analysisData.skinResults)}\n`;
        if (!analysisSummary) analysisSummary = 'No specific analysis data provided — build a general male appearance improvement plan.';

        const systemPrompt = `You are a world-class men's grooming and aesthetics coach.
You specialize in evidence-based, practical improvements to male appearance — grooming, skincare, haircut strategy, fitness, styling, and lifestyle habits that affect how a man looks.
You write with precision, confidence, and zero fluff. Your plans are specific, actionable, and time-bound.`;

        const userPrompt = `Based on this facial analysis, create a personalized 3-month plan to help this man maximize his appearance.

Analysis data:
${analysisSummary}

Write a 3-month week-by-week plan. Format it as clean HTML using only inline styles and basic tags (h3, p, ul, li, strong).
Use color var(--accent, #b4ff3c) for headings. Use white (#fff) for body text. Background transparent.
Be specific — name exact products, exact exercises, exact habits. No vague advice.
Structure: Month 1 (Foundation), Month 2 (Refinement), Month 3 (Optimization). Each month has 4 weekly focuses.
End with a "Daily Non-Negotiables" section (5 habits to do every single day).`;

        const payload = JSON.stringify({
          model: 'claude-opus-4-5',
          max_tokens: 2000,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        });

        const options = {
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(payload),
          },
        };

        const apiReq = https.request(options, apiRes => {
          const chunks = [];
          apiRes.on('data', c => chunks.push(c));
          apiRes.on('end', () => {
            try {
              const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              const html = data.content?.[0]?.text || '';
              res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
              res.end(JSON.stringify({ html }));
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Failed to parse Claude response' }));
            }
          });
        });
        apiReq.on('error', e => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        });
        apiReq.write(payload);
        apiReq.end();

      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }


  // ── Perfect Corp (YouCam) V2 API — face enhancement pipeline ───────────────
  // V2 auth = just "Authorization: Bearer <API_KEY>", no client_secret/id_token needed.
  // Flow per feature: POST file/{feature} -> PUT bytes to presigned url -> POST task/{feature} -> GET task/{feature}/{task_id} (poll)
  if (req.method === 'POST' && req.url === '/api/face-reshape') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const { imageBase64, mimeType = 'image/jpeg' } = JSON.parse(Buffer.concat(chunks).toString());
        const imgBuf = Buffer.from(imageBase64, 'base64');
        const contentType = mimeType.includes('png') ? 'image/png' : 'image/jpeg';
        const fileName = contentType === 'image/png' ? 'photo.png' : 'photo.jpg';

        // ── Step 1: upload the source photo once via the makeup-vto File API ──
        console.log('[pc-pipeline] uploading source photo...');
        const fileId = await pcUploadFile('makeup-vto', imgBuf, contentType, fileName);
        console.log('[pc-pipeline] uploaded, file_id:', fileId);

        // ── Step 2: run AI Makeup Virtual Try-On with a masculine enhancement look ──
        // Schema confirmed directly from Perfect Corp's own Playground-generated request code.
        const taskBody = buildMakeupVtoTaskBody(fileId);

        console.log('[pc-pipeline] running makeup-vto task...');
        const resultData = await pcRunTask('makeup-vto', taskBody, 'makeup-vto');
        const resultUrl = resultData?.results?.url || resultData?.results?.output?.[0]?.url || resultData?.output?.[0] || resultData?.url;
        if (!resultUrl) throw new Error('makeup-vto: no result url in: ' + JSON.stringify(resultData).slice(0,300));

        const finalBuf = await pcFetchBuf(resultUrl);
        const b64 = finalBuf.toString('base64');
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ b64, format: 'jpg' }));

      } catch (e) {
        console.error('[face-reshape:perfectcorp] Error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── Inpaint: masked photo edit via OpenAI gpt-image-1 ──────────────────────
  // ── AILab Tools 4-step enhancement pipeline (dormant — kept for reference) ─
  // Step 1: Face Beauty (sync)  → Step 2: Skin Enhancement (sync)
  // Step 3: Eyebrows (async)    → Step 4: Eyelashes (async)
  if (req.method === 'POST' && req.url === '/api/face-reshape-ailab-old') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const { imageBase64, mimeType = 'image/jpeg' } = JSON.parse(Buffer.concat(chunks).toString());
        const ext = mimeType.includes('png') ? 'png' : 'jpg';

        // ── Helpers ──────────────────────────────────────────────────────
        // POST multipart to AILab; fields = {name:value}, files = {name:{filename,mime,data}}
        function ailabPost(apiPath, fields, files) {
          return new Promise((resolve, reject) => {
            const boundary = '----AILab' + Math.random().toString(36).slice(2);
            const CRLF = '\r\n';
            const parts = [];
            for (const [k, v] of Object.entries(fields || {}))
              parts.push(Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="${k}"${CRLF}${CRLF}${v}${CRLF}`, 'utf8'));
            for (const [k, {filename, mime, data}] of Object.entries(files || {}))
              parts.push(Buffer.concat([
                Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="${k}"; filename="${filename}"${CRLF}Content-Type: ${mime}${CRLF}${CRLF}`, 'utf8'),
                data, Buffer.from(CRLF, 'utf8'),
              ]));
            parts.push(Buffer.from(`--${boundary}--${CRLF}`, 'utf8'));
            const body = Buffer.concat(parts);
            const r = https.request({
              hostname: 'www.ailabapi.com', path: apiPath, method: 'POST',
              headers: { 'ailabapi-api-key': AILABTOOLS_KEY, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length }
            }, apiRes => {
              const bufs = []; apiRes.on('data', c => bufs.push(c));
              apiRes.on('end', () => {
                const txt = Buffer.concat(bufs).toString();
                console.log(`[ailabPost] ${apiPath} http:${apiRes.statusCode} body:${txt.slice(0,300)}`);
                try { resolve(JSON.parse(txt)); } catch(_) { reject(new Error(`Non-JSON from ${apiPath} (http ${apiRes.statusCode}): ${txt.slice(0,200)}`)); }
              });
            });
            r.on('error', reject); r.write(body); r.end();
          });
        }

        // GET from AILab (for polling)
        function ailabGet(apiPath) {
          return new Promise((resolve, reject) => {
            const r = https.request({
              hostname: 'www.ailabapi.com', path: apiPath, method: 'GET',
              headers: { 'ailabapi-api-key': AILABTOOLS_KEY }
            }, apiRes => {
              const bufs = []; apiRes.on('data', c => bufs.push(c));
              apiRes.on('end', () => {
                const txt = Buffer.concat(bufs).toString();
                try { resolve(JSON.parse(txt)); } catch(e) { reject(new Error(`Non-JSON poll (http ${apiRes.statusCode}): ${txt.slice(0,200)}`)); }
              });
            });
            r.on('error', reject); r.end();
          });
        }

        // Fetch any URL → Buffer (follows up to 5 redirects)
        function fetchBuf(url, redirects = 0) {
          return new Promise((resolve, reject) => {
            if (redirects > 5) return reject(new Error('Too many redirects: ' + url));
            const u = new URL(url);
            https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
              if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const next = res.headers.location.startsWith('http') ? res.headers.location : `https://${u.hostname}${res.headers.location}`;
                res.resume();
                return resolve(fetchBuf(next, redirects + 1));
              }
              const bufs = []; res.on('data', c => bufs.push(c)); res.on('end', () => resolve(Buffer.concat(bufs)));
            }).on('error', reject).end();
          });
        }

        // Poll async task until succeeded; returns first result URL
        async function pollTask(taskId, label) {
          for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 5000));
            const r = await ailabGet(`/api/ai-common/async-task-result?task_id=${encodeURIComponent(taskId)}`);
            const status = r.data?.task_status;
            console.log(`[ailab:${label}] poll ${i+1} status:`, status);
            if (status === 'succeeded') return r.data.result_urls[0];
            if (status === 'failed') throw new Error(`${label} task failed`);
          }
          throw new Error(`${label} task timed out`);
        }

        // ── Step 1: Face Beauty (sync) ────────────────────────────────────
        console.log('[pipeline] Step 1: Face Beauty');
        const imgBuf0 = Buffer.from(imageBase64, 'base64');
        const r1 = await ailabPost('/api/portrait/effects/face-beauty', { sharp: '0.5', smooth: '0.5', white: '0.2' }, { image: { filename: `photo.${ext}`, mime: mimeType, data: imgBuf0 } });
        if (r1.error_code !== 0) throw new Error('Face Beauty: ' + r1.error_msg);
        const imgBuf1 = await fetchBuf(r1.data.image_url);
        console.log('[pipeline] Step 1 done, got', imgBuf1.length, 'bytes');

        // ── Step 2: Skin Enhancement (sync) ───────────────────────────────
        console.log('[pipeline] Step 2: Skin Enhancement');
        const r2 = await ailabPost('/api/portrait/effects/smart-skin', { retouch_degree: '0.7', whitening_degree: '0.2' }, { image: { filename: `photo.jpg`, mime: 'image/jpeg', data: imgBuf1 } });
        if (r2.error_code !== 0) throw new Error('Skin Enhancement: ' + r2.error_msg);
        const imgBuf2 = await fetchBuf(r2.data.image_url);
        console.log('[pipeline] Step 2 done, got', imgBuf2.length, 'bytes');

        // Helper: get task_id from either top-level or data.task_id
        function getTaskId(r) { return r.task_id || r.data?.task_id; }
        // Helper: get image URL from sync response
        function getSyncUrl(r) { return r.data?.image_url || r.image_url; }
        // Helper: handle async OR sync AILab response; returns Buffer
        async function resolveAilabResult(r, label) {
          if (r.error_code !== undefined && r.error_code !== 0) throw new Error(`${label}: ${r.error_msg}`);
          if (!r.error_code && !getTaskId(r) && !getSyncUrl(r)) throw new Error(`${label}: unexpected response: ` + JSON.stringify(r).slice(0,200));
          const taskId = getTaskId(r);
          if (taskId) {
            console.log(`[pipeline] ${label} async task_id:`, taskId);
            const url = await pollTask(taskId, label);
            return fetchBuf(url);
          }
          const syncUrl = getSyncUrl(r);
          if (syncUrl) {
            console.log(`[pipeline] ${label} sync image_url:`, syncUrl.slice(0,80));
            return fetchBuf(syncUrl);
          }
          throw new Error(`${label}: no task_id or image_url in response: ` + JSON.stringify(r).slice(0,200));
        }

        // ── Step 3: Eyebrows (async) ──────────────────────────────────────
        const EYEBROW_REF_URL = 'https://ai-resource.ailabtools.com/rapidapi/facebody/AIBeauty/OriginalImage-1.webp';
        let imgBuf3 = imgBuf2; // fallback: skip eyebrows if step fails
        try {
          console.log('[pipeline] Step 3: Eyebrows — fetching reference...');
          const refBuf = await fetchBuf(EYEBROW_REF_URL);
          console.log('[pipeline] Step 3: ref image bytes:', refBuf.length);
          const r3 = await ailabPost('/api/portrait/editing/ai-eyebrows', { resolution: '2K' }, {
            image:           { filename: 'photo.jpg',     mime: 'image/jpeg', data: imgBuf2 },
            reference_image: { filename: 'reference.webp', mime: 'image/webp', data: refBuf  },
          });
          imgBuf3 = await resolveAilabResult(r3, 'eyebrows');
          console.log('[pipeline] Step 3 done, got', imgBuf3.length, 'bytes');
        } catch(browErr) {
          console.warn('[pipeline] Step 3 SKIPPED (eyebrows error):', browErr.message);
        }

        // ── Step 4: Eyelashes (async or sync) ────────────────────────────
        let imgBuf4 = imgBuf3; // fallback: skip if fails
        try {
          console.log('[pipeline] Step 4: Eyelashes');
          // Try common AILab style params; log response so we can see what it wants
          const r4 = await ailabPost('/api/portrait/editing/ai-eyelashes',
            { type: '1' },
            { image: { filename: 'photo.jpg', mime: 'image/jpeg', data: imgBuf3 } }
          );
          imgBuf4 = await resolveAilabResult(r4, 'eyelashes');
          console.log('[pipeline] Step 4 done, got', imgBuf4.length, 'bytes');
        } catch(lashErr) {
          console.warn('[pipeline] Step 4 SKIPPED (eyelashes error):', lashErr.message);
        }

        // ── Return final result ───────────────────────────────────────────
        const b64 = imgBuf4.toString('base64');
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ b64, format: 'jpg' }));

      } catch(e) {
        console.error('[face-reshape] Error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── Flux Fill inpainting via Replicate ───────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/inpaint-flux') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const { imageBase64, maskBase64, prompt } = JSON.parse(Buffer.concat(chunks).toString());

        // Flux Fill expects data URIs
        const imageDataUri = `data:image/png;base64,${imageBase64}`;
        const maskDataUri  = `data:image/png;base64,${maskBase64}`;

        const payload = JSON.stringify({
          input: {
            image: imageDataUri,
            mask:  maskDataUri,
            prompt: prompt,
            num_inference_steps: 28,
            guidance_scale: 7.5,
            output_format: 'png'
          }
        });

        // Helper: make an HTTPS request and return parsed JSON body
        function httpsJSON(opts, body) {
          return new Promise((resolve, reject) => {
            const r = https.request(opts, res => {
              const bufs = [];
              res.on('data', c => bufs.push(c));
              res.on('end', () => {
                try { resolve(JSON.parse(Buffer.concat(bufs).toString())); }
                catch(e) { reject(new Error('Non-JSON response: ' + Buffer.concat(bufs).toString().slice(0,200))); }
              });
            });
            r.on('error', reject);
            if (body) r.write(body);
            r.end();
          });
        }

        const payBuf = Buffer.from(payload);
        const pred = await httpsJSON({
          hostname: 'api.replicate.com',
          path:     '/v1/models/black-forest-labs/flux-fill-dev/predictions',
          method:   'POST',
          headers: {
            'Authorization': `Bearer ${REPLICATE_KEY}`,
            'Content-Type':  'application/json',
            'Content-Length': payBuf.length,
            'Prefer': 'wait=60'
          }
        }, payBuf);

        console.log('[flux] created prediction:', pred.id, 'status:', pred.status);

        let outputUrls = pred.output;

        // Poll if not already done
        if (pred.status !== 'succeeded' && pred.status !== 'failed') {
          for (let i = 0; i < 40; i++) {
            await new Promise(r => setTimeout(r, 3000));
            const poll = await httpsJSON({
              hostname: 'api.replicate.com',
              path:     `/v1/predictions/${pred.id}`,
              method:   'GET',
              headers:  { 'Authorization': `Bearer ${REPLICATE_KEY}` }
            });
            console.log('[flux] poll', i+1, 'status:', poll.status);
            if (poll.status === 'succeeded') { outputUrls = poll.output; break; }
            if (poll.status === 'failed') throw new Error('Flux failed: ' + (poll.error || 'unknown'));
          }
        }

        if (!outputUrls || !outputUrls[0]) throw new Error('No output URL from Flux');

        // Fetch the image bytes and return as base64
        const imgB64 = await new Promise((resolve, reject) => {
          const u = new URL(outputUrls[0]);
          const r = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET' }, imgRes => {
            const bufs = [];
            imgRes.on('data', c => bufs.push(c));
            imgRes.on('end', () => resolve(Buffer.concat(bufs).toString('base64')));
          });
          r.on('error', reject);
          r.end();
        });

        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ b64: imgB64, format: 'png' }));

      } catch(e) {
        console.error('[inpaint-flux] Error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/inpaint') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const { imageBase64, maskBase64, prompt } = JSON.parse(Buffer.concat(chunks).toString());

        // Both image and mask must be RGBA PNG for OpenAI inpainting
        const imgBuf  = Buffer.from(imageBase64, 'base64');
        const maskBuf = Buffer.from(maskBase64,  'base64');

        const boundary = '----InpaintBoundary' + Math.random().toString(36).slice(2);
        const CRLF = '\r\n';

        function textField(name, value) {
          return Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`, 'utf8');
        }
        function fileField(name, filename, mime, data) {
          return Buffer.concat([
            Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"; filename="${filename}"${CRLF}Content-Type: ${mime}${CRLF}${CRLF}`, 'utf8'),
            data,
            Buffer.from(CRLF, 'utf8'),
          ]);
        }

        const bodyBuf = Buffer.concat([
          textField('model',   'gpt-image-1'),
          textField('prompt',  prompt),
          textField('size',    '1024x1024'),
          textField('quality', 'high'),
          textField('n',       '1'),
          fileField('image',   'image.png', 'image/png', imgBuf),
          fileField('mask',    'mask.png',  'image/png', maskBuf),
          Buffer.from(`--${boundary}--${CRLF}`, 'utf8'),
        ]);

        const options = {
          hostname: 'api.openai.com',
          path: '/v1/images/edits',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${OPENAI_KEY}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': bodyBuf.length,
          }
        };

        const apiReq = https.request(options, apiRes => {
          const bufs = [];
          apiRes.on('data', c => bufs.push(c));
          apiRes.on('end', () => {
            const raw = Buffer.concat(bufs).toString('utf8');
            console.log('[inpaint] OpenAI status:', apiRes.statusCode, raw.slice(0, 200));
            res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            try { JSON.parse(raw); res.end(raw); }
            catch(_) { res.end(JSON.stringify({ error: `OpenAI returned non-JSON: ${raw.slice(0, 300)}` })); }
          });
        });
        apiReq.on('error', e => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        });
        apiReq.write(bodyBuf);
        apiReq.end();

      } catch(e) {
        console.error('[inpaint] Error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── Detect eye bounding boxes via GPT-4o-mini vision ─────────────────────
  if (req.method === 'POST' && req.url === '/api/detect-eyes') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const { imageBase64, mimeType } = JSON.parse(Buffer.concat(chunks).toString());
        const dataUrl = `data:${mimeType || 'image/jpeg'};base64,${imageBase64}`;

        const payload = JSON.stringify({
          model: 'gpt-4o-mini',
          max_tokens: 300,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Look at this portrait photo. Return ONLY a raw JSON object — no markdown, no explanation, no code fences. Give the bounding box of each eye as decimal fractions of the full image dimensions (0.0 = left/top edge, 1.0 = right/bottom edge). x and y are the top-left corner of the box. Add 20% padding around each eye so the full lash line is included. Format: {"leftEye":{"x":0.0,"y":0.0,"w":0.0,"h":0.0},"rightEye":{"x":0.0,"y":0.0,"w":0.0,"h":0.0}}'
              },
              { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } }
            ]
          }]
        });

        const options = {
          hostname: 'api.openai.com',
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${OPENAI_KEY}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        };

        const apiReq = https.request(options, apiRes => {
          const bufs = [];
          apiRes.on('data', c => bufs.push(c));
          apiRes.on('end', () => {
            try {
              const parsed = JSON.parse(Buffer.concat(bufs).toString());
              const text = parsed.choices?.[0]?.message?.content?.trim() || '';
              // Strip any accidental markdown fences
              const clean = text.replace(/```[a-z]*\n?/g, '').replace(/```/g, '').trim();
              const eyes = JSON.parse(clean);
              res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
              res.end(JSON.stringify(eyes));
            } catch(e) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Failed to parse eye coordinates: ' + e.message }));
            }
          });
        });
        apiReq.on('error', e => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        });
        apiReq.write(payload);
        apiReq.end();
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── Generate Potential via OpenAI gpt-image-1 ──
  if (req.method === 'POST' && req.url === '/api/generate-potential') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { imageBase64, prompt } = JSON.parse(body);

        // Convert base64 to PNG buffer for multipart upload
        const imgBuffer = Buffer.from(imageBase64, 'base64');

        // Build multipart/form-data manually
        const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
        const CRLF = '\r\n';

        const parts = [];

        // model
        parts.push(
          `--${boundary}${CRLF}Content-Disposition: form-data; name="model"${CRLF}${CRLF}gpt-image-1`
        );
        // prompt
        parts.push(
          `--${boundary}${CRLF}Content-Disposition: form-data; name="prompt"${CRLF}${CRLF}${prompt}`
        );
        // size
        parts.push(
          `--${boundary}${CRLF}Content-Disposition: form-data; name="size"${CRLF}${CRLF}1024x1024`
        );
        // quality
        parts.push(
          `--${boundary}${CRLF}Content-Disposition: form-data; name="quality"${CRLF}${CRLF}high`
        );
        // n
        parts.push(
          `--${boundary}${CRLF}Content-Disposition: form-data; name="n"${CRLF}${CRLF}1`
        );

        // image file
        const fileHeader = `--${boundary}${CRLF}Content-Disposition: form-data; name="image"; filename="photo.png"${CRLF}Content-Type: image/png${CRLF}${CRLF}`;

        const textPart = Buffer.from(parts.join(CRLF) + CRLF, 'utf8');
        const fileHeaderBuf = Buffer.from(fileHeader, 'utf8');
        const closing = Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'utf8');

        const bodyBuf = Buffer.concat([textPart, fileHeaderBuf, imgBuffer, closing]);

        const options = {
          hostname: 'api.openai.com',
          path: '/v1/images/edits',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${OPENAI_KEY}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': bodyBuf.length,
          }
        };

        const apiReq = https.request(options, apiRes => {
          const chunks = [];
          apiRes.on('data', c => chunks.push(c));
          apiRes.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            // If OpenAI returned non-JSON (Cloudflare error page, etc.), wrap it
            try {
              JSON.parse(raw);
              res.end(raw);
            } catch (_) {
              res.end(JSON.stringify({ error: `OpenAI returned non-JSON (status ${apiRes.statusCode}): ${raw.slice(0, 300)}` }));
            }
          });
        });

        apiReq.on('error', err => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });

        apiReq.write(bodyBuf);
        apiReq.end();

      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── 3-Month Potential Simulator ───────────────────────────────────────────
  // ── Experiment: single isolated edit ──────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/experiment') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const { imageBase64, mimeType, prompt, negativePrompt } = JSON.parse(Buffer.concat(chunks).toString());

        const dataUri = `data:${mimeType || 'image/jpeg'};base64,${imageBase64}`;
        const body = JSON.stringify({
          version: '8baa7ef2255075b46f4d91cd238c21d31181b3e6a864463f967960bb0112525b',
          input: {
            main_face_image: dataUri,
            prompt,
            negative_prompt: negativePrompt || 'different person, ugly, deformed, blurry, watermark, text, bad quality',
            width: 896,
            height: 1152,
            num_steps: 20,
            start_step: 0,
            id_weight: 1.5,
            guidance_scale: 4.0,
            true_cfg: 1.0,
            max_sequence_length: 128,
            output_format: 'png',
            num_outputs: 1,
          }
        });

        const startOpts = {
          hostname: 'api.replicate.com',
          path: '/v1/predictions',
          method: 'POST',
          headers: {
            'Authorization': `Token ${REPLICATE_KEY}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          }
        };

        const prediction = await new Promise((resolve, reject) => {
          const r = https.request(startOpts, res2 => {
            const bufs = [];
            res2.on('data', c => bufs.push(c));
            res2.on('end', () => { try { resolve(JSON.parse(Buffer.concat(bufs).toString())); } catch(e) { reject(e); } });
          });
          r.on('error', reject);
          r.write(body);
          r.end();
        });

        console.log('[experiment] Replicate:', JSON.stringify(prediction).slice(0, 200));
        if (!prediction.id) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: prediction.error || prediction.detail || 'No prediction ID' }));
          return;
        }

        const imageUrl = await new Promise((resolve, reject) => {
          let polls = 0;
          function poll() {
            if (++polls > 60) { reject(new Error('Timed out')); return; }
            const r = https.request({
              hostname: 'api.replicate.com',
              path: `/v1/predictions/${prediction.id}`,
              method: 'GET',
              headers: { 'Authorization': `Token ${REPLICATE_KEY}` }
            }, res2 => {
              const bufs = [];
              res2.on('data', c => bufs.push(c));
              res2.on('end', () => {
                try {
                  const p = JSON.parse(Buffer.concat(bufs).toString());
                  console.log('[experiment] poll', polls, p.status);
                  if (p.status === 'succeeded') resolve(Array.isArray(p.output) ? p.output[0] : p.output);
                  else if (p.status === 'failed' || p.status === 'canceled') reject(new Error(p.error || 'Failed'));
                  else setTimeout(poll, 2500);
                } catch(e) { setTimeout(poll, 2500); }
              });
            });
            r.on('error', () => setTimeout(poll, 2500));
            r.end();
          }
          setTimeout(poll, 2500);
        });

        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ imageUrl }));
      } catch(e) {
        console.error('[experiment] Error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/simulate') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString());
        const { imageBase64, mimeType, hairData, browData, eyeData, skinData, roadmapText } = parsed;

        // ── 3-Month Potential image now chains three confirmed Perfect Corp pipelines:
        // 1) makeup-vto (eyebrows/eyelashes/foundation/concealer) on the original photo, then
        // 2) face-reshape (eyes) run on THAT result.
        // Response contract ({imageUrl, improvements}) is unchanged so glowai.html's
        // simulatePotential() doesn't need to change.
        const contentType = (mimeType || '').includes('png') ? 'image/png' : 'image/jpeg';
        const fileName = contentType === 'image/png' ? 'photo.png' : 'photo.jpg';
        const imgBuf = Buffer.from(imageBase64, 'base64');

        // ── Step 1: makeup-vto (brows/lashes/foundation/concealer) on the original photo ──
        console.log('[simulate:pc] uploading source photo for makeup-vto...');
        const makeupFileId = await pcUploadFile('makeup-vto', imgBuf, contentType, fileName);
        console.log('[simulate:pc] uploaded, file_id:', makeupFileId);

        const taskBody = buildMakeupVtoTaskBody(makeupFileId);
        console.log('[simulate:pc] running makeup-vto task...');
        const resultData = await pcRunTask('makeup-vto', taskBody, 'makeup-vto');
        const resultUrl = resultData?.results?.url || resultData?.results?.output?.[0]?.url || resultData?.output?.[0] || resultData?.url;
        if (!resultUrl) throw new Error('makeup-vto: no result url in: ' + JSON.stringify(resultData).slice(0,300));
        const makeupBuf = await pcFetchBuf(resultUrl);

        // ── Step 2: face-reshape (eyes) on the makeup-vto result ──
        console.log('[simulate:pc] uploading makeup-vto result for face-reshape (eyes)...');
        const eyesFileId = await pcUploadFile('face-reshape', makeupBuf, 'image/jpeg', 'makeup-result.jpg', 'v2.0');
        console.log('[simulate:pc] uploaded, file_id:', eyesFileId);

        const eyesTaskBody = buildFaceReshapeTaskBody(eyesFileId);
        console.log('[simulate:pc] running face-reshape (eyes) task...');
        const eyesResultData = await pcRunTask('face-reshape', eyesTaskBody, 'face-reshape', 'v2.0');
        const eyesResultUrl = eyesResultData?.results?.url || eyesResultData?.results?.output?.[0]?.url || eyesResultData?.output?.[0] || eyesResultData?.url;
        if (!eyesResultUrl) throw new Error('face-reshape: no result url in: ' + JSON.stringify(eyesResultData).slice(0,300));
        const eyesBuf = await pcFetchBuf(eyesResultUrl);

        const b64 = eyesBuf.toString('base64');
        const imageUrl = `data:image/jpeg;base64,${b64}`;

        // Fixed improvements list reflecting what this pipeline actually changes.
        const improvements = [
          'Brows: thicker, denser, well-defined',
          'Eyelashes: fuller, more defined',
          'Skin: even tone with healthy glow (foundation)',
          'Eyes: brightened under-eyes, no dark circles (concealer)',
          'Eyes: enlarged, more open and symmetrical shape (face-reshape)',
          'Face: sharper cheekbones and jawline, refined chin length (face-reshape)'
        ];

        console.log('[simulate:pc] done.');
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ imageUrl, improvements }));

      } catch(e) {
        console.error('[simulate] Error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── Hair Try-On via Replicate FLUX-PuLID ──────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/hair-tryon') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const { imageBase64, mimeType, styleId } = JSON.parse(Buffer.concat(chunks).toString());

        // Hair Try-On now runs through Perfect Corp's hair-transfer V2.1 API (confirmed
        // request schema from the user's real Playground-generated code) instead of
        // Replicate FLUX-PuLID. Always uses the "wavy undercut" template per the user's
        // instruction, regardless of which style button was clicked.
        const contentType = (mimeType || '').includes('png') ? 'image/png' : 'image/jpeg';
        const fileName = contentType === 'image/png' ? 'photo.png' : 'photo.jpg';
        const imgBuf = Buffer.from(imageBase64, 'base64');

        console.log('[hair-tryon:pc] uploading source photo...');
        const fileId = await pcUploadFile('hair-transfer', imgBuf, contentType, fileName, 'v2.1');
        console.log('[hair-tryon:pc] uploaded, file_id:', fileId);

        const templateId = HAIR_TEMPLATE_MAP[styleId] || 'male_wavy_undercut';
        const taskBody = { src_file_id: fileId, template_id: templateId, hair_color: 'src' };

        console.log('[hair-tryon:pc] running hair-transfer task with template:', templateId);
        const resultData = await pcRunTask('hair-transfer', taskBody, 'hair-transfer', 'v2.1');
        const resultUrl = resultData?.results?.url || resultData?.results?.output?.[0]?.url || resultData?.output?.[0] || resultData?.url;
        if (!resultUrl) throw new Error('hair-transfer: no result url in: ' + JSON.stringify(resultData).slice(0,300));

        const finalBuf = await pcFetchBuf(resultUrl);
        const b64 = finalBuf.toString('base64');
        const imageUrl = `data:image/jpeg;base64,${b64}`;

        console.log('[hair-tryon:pc] done.');
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ imageUrl }));

      } catch(e) {
        console.error('[hair-tryon] Error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // General static file handler (weights, PNGs, HTML, etc.)
  if (req.method === 'GET') {
    const safePath = path.join(__dirname, decodeURIComponent(req.url.split('?')[0]));
    if (safePath.startsWith(__dirname + path.sep) && fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
      const ext = path.extname(safePath).toLowerCase();
      const mime = { '.html':'text/html', '.js':'application/javascript', '.json':'application/json',
        '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.css':'text/css',
        '.bin':'application/octet-stream', '.webp':'image/webp' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      fs.createReadStream(safePath).pipe(res);
      return;
    }
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✓ Protocol running at http://localhost:${PORT}\n`);
});
