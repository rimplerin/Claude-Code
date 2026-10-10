// Vertex AI (Gemini image / "Nano Banana") client using a service-account JSON key.
import { JWT } from 'google-auth-library';
import { fetch, Agent, EnvHttpProxyAgent } from 'undici';

const hasProxy = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some((k) => process.env[k]);
// Generation can take minutes, so header/body timeouts are disabled here and the
// per-request AbortSignal (requestTimeoutSec) decides when to give up.
const agentOptions = { headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30_000, keepAliveTimeout: 4_000 };
const dispatcher = hasProxy ? new EnvHttpProxyAgent(agentOptions) : new Agent(agentOptions);

const SAFETY_CATEGORIES = [
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_HARASSMENT',
];

export class VertexError extends Error {
  constructor(kind, message, { status, retryAfterMs, detail } = {}) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.detail = detail;
  }

  // network / timeout / 429 / 5xx -> retry with backoff
  get transient() {
    return ['network', 'timeout', 'rate_limit', 'server'].includes(this.kind);
  }

  // safety block or text-only answer -> output is random, so another try often works
  get blockedLike() {
    return ['blocked', 'no_image'].includes(this.kind);
  }
}

// ---------- credentials ----------
export function validateCredentials(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('JSON 파일을 읽을 수 없습니다.');
  if (obj.type && obj.type !== 'service_account') {
    throw new Error(`서비스 계정 키가 아닙니다 (type: ${obj.type}). IAM > 서비스 계정 > 키 에서 JSON 키를 만들어 주세요.`);
  }
  for (const field of ['project_id', 'private_key', 'client_email']) {
    if (!obj[field]) throw new Error(`JSON에 "${field}" 항목이 없습니다.`);
  }
  return {
    type: 'service_account',
    project_id: obj.project_id,
    private_key_id: obj.private_key_id,
    private_key: obj.private_key,
    client_email: obj.client_email,
    client_id: obj.client_id,
  };
}

let authCache = null;

function authClient(creds) {
  const cacheKey = `${creds.client_email}|${creds.private_key_id || creds.private_key.length}`;
  if (authCache?.key !== cacheKey) {
    authCache = {
      key: cacheKey,
      client: new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      }),
    };
  }
  return authCache.client;
}

export async function getAccessToken(creds) {
  if (process.env.VERTEX_STATIC_TOKEN) return process.env.VERTEX_STATIC_TOKEN; // testing against a mock endpoint
  try {
    const { token } = await authClient(creds).getAccessToken();
    if (!token) throw new Error('empty token');
    return token;
  } catch (err) {
    const msg = String(err?.message || err);
    if (/invalid_grant|account not found|Invalid JWT|DECODER|PEM|private key|asn1/i.test(msg)) {
      throw new VertexError('auth', `서비스 계정 인증 실패: ${msg} (키가 삭제/비활성화되었거나 PC 시간이 맞지 않을 수 있습니다)`);
    }
    // token endpoint unreachable -> transient
    throw new VertexError('network', `인증 토큰 발급 실패: ${msg}`);
  }
}

function endpoint(location, project, model, method) {
  if (process.env.VERTEX_API_BASE) {
    return `${process.env.VERTEX_API_BASE}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:${method}`;
  }
  const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:${method}`;
}

function parseRetryAfter(header) {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return secs * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function httpError(status, bodyText, headers, model) {
  let message = bodyText.slice(0, 600);
  let apiStatus = '';
  try {
    const j = JSON.parse(bodyText);
    const e = Array.isArray(j) ? j[0]?.error : j.error;
    if (e) {
      message = e.message || message;
      apiStatus = e.status || '';
    }
  } catch { /* not JSON */ }
  const retryAfterMs = parseRetryAfter(headers.get('retry-after'));
  const opts = { status, retryAfterMs, detail: apiStatus };
  if (status === 429 || apiStatus === 'RESOURCE_EXHAUSTED') {
    return new VertexError('rate_limit', `요청 한도 초과(429): ${message}`, opts);
  }
  if (status === 408 || status >= 500) {
    return new VertexError('server', `서버 오류(${status}): ${message}`, opts);
  }
  if (status === 401 || status === 403) {
    return new VertexError('auth', `권한 오류(${status}): ${message} — Vertex AI API 사용 설정, 결제 계정 연결, 서비스 계정의 "Vertex AI 사용자" 역할을 확인하세요.`, opts);
  }
  if (status === 404) {
    return new VertexError('not_found', `모델을 찾을 수 없음(404): "${model}" — 설정에서 모델 ID와 리전(location)을 확인하세요. ${message}`, opts);
  }
  return new VertexError('bad_request', `요청 오류(${status}): ${message}`, opts);
}

async function postJson(url, token, body, { timeoutMs, signal, model }) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signals = signal ? [signal, timeoutSignal] : [timeoutSignal];
  let res;
  let text;
  try {
    res = await fetch(url, {
      method: 'POST',
      dispatcher,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
    text = await res.text();
  } catch (err) {
    if (signal?.aborted) throw new VertexError('canceled', '취소됨');
    if (timeoutSignal.aborted) throw new VertexError('timeout', `응답 시간 초과 (${Math.round(timeoutMs / 1000)}초)`);
    const cause = err?.cause;
    const code = cause?.code || cause?.name || '';
    throw new VertexError('network', `네트워크 오류 (fetch failed${code ? `: ${code}` : ''}) ${cause?.message || err?.message || ''}`.trim());
  }
  if (!res.ok) throw httpError(res.status, text, res.headers, model);
  try {
    return JSON.parse(text);
  } catch {
    throw new VertexError('server', `응답 파싱 실패: ${text.slice(0, 200)}`);
  }
}

const BLOCK_REASONS_KO = {
  SAFETY: '안전 필터',
  IMAGE_SAFETY: '이미지 안전 필터',
  PROHIBITED_CONTENT: '금지 콘텐츠 판정',
  IMAGE_PROHIBITED_CONTENT: '금지 이미지 판정',
  BLOCKLIST: '차단 단어',
  SPII: '민감 개인정보',
  RECITATION: '저작물 재현 판정',
  IMAGE_RECITATION: '이미지 저작물 재현 판정',
  IMAGE_OTHER: '이미지 생성 실패(기타)',
  NO_IMAGE: '이미지 미생성',
  OTHER: '기타 사유',
  MALFORMED_FUNCTION_CALL: '잘못된 응답',
};

function parseImageResponse(json) {
  const fb = json.promptFeedback;
  if (fb?.blockReason) {
    throw new VertexError('blocked', `입력 차단: ${BLOCK_REASONS_KO[fb.blockReason] || ''} (${fb.blockReason}) ${fb.blockReasonMessage || ''}`.trim(), { detail: fb.blockReason });
  }
  const cand = json.candidates?.[0];
  if (!cand) throw new VertexError('no_image', '응답에 결과가 없습니다.');
  const parts = cand.content?.parts || [];
  const texts = parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('\n').trim();
  // Thinking models may stream interim "thought" images first; the final answer is the last non-thought image.
  const images = parts.filter((p) => (p.inlineData || p.inline_data)?.data && !p.thought);
  if (images.length) {
    const inline = images[images.length - 1].inlineData || images[images.length - 1].inline_data;
    return {
      mime: inline.mimeType || inline.mime_type || 'image/png',
      buffer: Buffer.from(inline.data, 'base64'),
      text: texts,
      finishReason: cand.finishReason,
      usage: json.usageMetadata,
    };
  }
  const reason = cand.finishReason || 'NO_IMAGE';
  if (reason !== 'STOP' && reason !== 'MAX_TOKENS') {
    throw new VertexError('blocked', `생성 차단: ${BLOCK_REASONS_KO[reason] || ''} (${reason})${cand.finishMessage ? ` ${cand.finishMessage}` : ''}${texts ? ` — 모델 응답: ${texts.slice(0, 200)}` : ''}`, { detail: reason });
  }
  throw new VertexError('no_image', `이미지 없이 텍스트만 응답함${texts ? `: ${texts.slice(0, 300)}` : ''}`, { detail: reason });
}

/**
 * Calls generateContent with image output.
 * parts: [{text}|{inlineData:{mimeType,data}}]
 */
export async function generateImage({ creds, location, model, parts, aspectRatio, imageSize, safetyThreshold = 'OFF', timeoutMs, signal }) {
  const token = await getAccessToken(creds);
  const url = endpoint(location, creds.project_id, model, 'generateContent');
  let threshold = safetyThreshold;
  let size = imageSize;
  let ratio = aspectRatio;
  // Some model versions reject OFF / imageSize; fall back automatically instead of failing the job.
  for (let attempt = 0; attempt < 4; attempt++) {
    const imageConfig = {};
    if (ratio) imageConfig.aspectRatio = ratio;
    if (size) imageConfig.imageSize = size;
    const body = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        candidateCount: 1,
        ...(Object.keys(imageConfig).length ? { imageConfig } : {}),
      },
      safetySettings: SAFETY_CATEGORIES.map((category) => ({ category, threshold })),
    };
    try {
      const json = await postJson(url, token, body, { timeoutMs, signal, model });
      return parseImageResponse(json);
    } catch (err) {
      if (err instanceof VertexError && err.kind === 'bad_request') {
        const m = err.message;
        if (threshold === 'OFF' && /threshold|safety_?setting/i.test(m)) { threshold = 'BLOCK_NONE'; continue; }
        if (size && /image_?size/i.test(m)) { size = undefined; continue; }
        if (ratio && /aspect_?ratio/i.test(m)) { ratio = undefined; continue; }
      }
      throw err;
    }
  }
  throw new VertexError('bad_request', '요청 형식 오류가 반복되었습니다.');
}

// Cheap connectivity/permission check: countTokens does not generate anything.
export async function testConnection({ creds, location, model }) {
  const token = await getAccessToken(creds);
  const url = endpoint(location, creds.project_id, model, 'countTokens');
  const json = await postJson(url, token, { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] }, { timeoutMs: 30_000, model });
  return { totalTokens: json.totalTokens };
}
