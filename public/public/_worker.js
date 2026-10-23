// CareerGuru AI backend (Cloudflare Pages advanced mode).
// Secrets (GEMINI_API_KEY etc.) live only in Cloudflare environment variables.
const A = x => (Array.isArray(x) ? x : []);
const LANGS = ['English', 'Telugu', 'Hinglish / Telugu-English mix'];
const GENERIC = 'We couldn’t complete the analysis right now. Please try again.';
const J = (o, s = 200) => Response.json(o, { status: s, headers: { 'Cache-Control': 'no-store' } });
const fail = (s, code, error) => J({ code, error }, s);

// One modular prompt per feature
const PROMPTS = {
  career: {
    sys: 'You are CareerGuru AI, a friendly, practical career mentor for Indian college students and freshers. Analyze the profile honestly (no flattery) and give 4 realistic career paths for the Indian entry-level market.',
    shape: '{"score":0-100 career readiness,"level":str,"summary":str(max 40 words),"strengths":[str],"weaknesses":[str],"missing_skills":[str],"paths":[{"title":str,"why":str,"skills":[str],"gaps":[str],"difficulty":"Easy|Medium|Hard","time":str,"growth":str,"next":str}],"roadmap":{"short":[str],"long":[str]}}',
    ok: o => o && typeof o.score === 'number' && A(o.paths).length > 0,
  },
  resume: {
    sys: 'You are an ATS and resume expert. Score this resume strictly (0-100 per category), list real problems found in this exact text, and give exact before/after rewrites.',
    shape: '{"overall":0-100,"scores":{"ATS":n,"Formatting":n,"Summary":n,"Skills":n,"Experience":n,"Projects":n,"Education":n,"Keywords":n,"Grammar":n,"Impact":n},"problems":[str],"fixes":[{"before":str,"after":str}],"improved_summary":str}',
    ok: o => o && typeof o.overall === 'number' && o.scores && typeof o.scores === 'object',
  },
  job: {
    sys: 'You are a recruiter-minded job match analyst. Compare the candidate to the job description honestly and specifically.',
    shape: '{"match":0-100,"breakdown":{"Technical skills":n,"Education":n,"Experience":n,"Soft skills":n,"Keywords":n},"required":[str],"missing":[str],"keywords":[str],"strong_because":str,"may_reject_because":str,"plan":[str]}',
    ok: o => o && typeof o.match === 'number' && o.breakdown && typeof o.breakdown === 'object',
  },
  chat: {
    sys: 'You are CareerGuru AI, a personal career mentor for Indian students and freshers, not a generic chatbot. Cover only career topics (jobs, skills, resume, interviews, projects, learning, placements, LinkedIn); politely steer anything else back. Personalize using the profile. Be concise: bold short headings, bullets, and one clear next step. Never write long blocks.',
  },
};

async function gemini(env, prompt, json) {
  const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: json ? { responseMimeType: 'application/json' } : {},
    }),
    signal: AbortSignal.timeout(55000),
  });
  if (!r.ok) throw new Error('gemini ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const d = await r.json();
  return A(d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts)
    .map(p => p.text || '').join('');
}

async function handleAi(request, env) {
  const url = env.SUPABASE_URL, key = env.SUPABASE_ANON_KEY;
  if (!url || !key || !env.GEMINI_API_KEY) return fail(500, 'config', 'The server is not configured yet.');
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer /, '');
  if (!token) return fail(401, 'auth', 'Please log in.');
  let body;
  try { body = await request.json(); } catch { return fail(400, 'input', 'Invalid request.'); }
  const { feature, input, history, profile } = body || {};
  if (!Object.prototype.hasOwnProperty.call(PROMPTS, feature)) return fail(400, 'input', 'Unknown feature.');
  const isChat = feature === 'chat';
  if (typeof input !== 'string' || !input.trim() || input.length > (isChat ? 2000 : 14000)) {
    return fail(400, 'input', 'Please check your input and try again.');
  }
  const lang = LANGS.includes(body.lang) ? body.lang : 'English';
  const P = PROMPTS[feature];

  // 1. Verify the logged-in, email-verified user
  const auth = { apikey: key, Authorization: 'Bearer ' + token };
  const ur = await fetch(url + '/auth/v1/user', { headers: auth });
  if (!ur.ok) return fail(401, 'auth', 'Please log in again.');
  const user = await ur.json();
  if (!user.email_confirmed_at) return fail(403, 'verify', 'Please verify your email first.');
  const rest = (path, o = {}) => fetch(url + '/rest/v1/' + path, {
    ...o, headers: { ...auth, 'Content-Type': 'application/json', ...(o.headers || {}) },
  });

  // 2. Plan and free-tier limits (read with the user's own token, so row security applies)
  const subs = await (await rest('subscriptions?select=plan_id,status,expiry_date&limit=1')).json();
  const sub = A(subs)[0];
  const pro = sub && sub.plan_id !== 'free' && sub.status === 'active' && (!sub.expiry_date || new Date(sub.expiry_date) > new Date());
  if (!pro) {
    const plan = A(await (await rest('plans?id=eq.free&select=limits')).json())[0];
    const lim = (plan && plan.limits) || {};
    const max = isChat ? lim.chat_per_day : lim[feature];
    if (max != null) {
      const since = new Date(); since.setUTCHours(0, 0, 0, 0);
      const q = isChat
        ? 'chat_messages?select=id&role=eq.user&created_at=gte.' + since.toISOString()
        : 'analyses?select=id&type=eq.' + feature;
      const cr = await rest(q, { headers: { Prefer: 'count=exact', Range: '0-0' } });
      const used = +((cr.headers.get('content-range') || '').split('/')[1]) || 0;
      if (used >= max) {
        return fail(429, 'limit', isChat
          ? `You’ve used your ${max} free chat questions for today. Upgrade to Pro for unlimited chat.`
          : `You’ve used your ${max} free ${feature} analyses. Upgrade to Pro for unlimited analyses.`);
      }
    }
  }

  // 3. Build the prompt for this feature
  let prompt;
  if (isChat) {
    const h = A(history).slice(-10)
      .map(x => (x && x.r === 'u' ? 'Student: ' : 'Mentor: ') + String((x && x.t) || '').slice(0, 1500)).join('\n');
    prompt = `${P.sys}\nWrite in ${lang}.\n\nPROFILE:\n${String(profile || '').slice(0, 2000) || '(not provided)'}\n\nCHAT SO FAR:\n${h}\nStudent: ${input}\nMentor:`;
  } else {
    prompt = `${P.sys}\nWrite all text values in ${lang}; keep JSON keys in English. Return ONLY valid JSON.\n\nSCHEMA: ${P.shape}\n\nDATA:\n${input}`;
  }

  // 4. Call the AI; JSON features are validated, with one retry
  let result;
  try {
    for (let i = 0; i < 2 && result === undefined; i++) {
      const txt = await gemini(env, prompt, !isChat);
      if (isChat) { if (txt.trim()) result = txt.trim(); continue; }
      try {
        const o = JSON.parse(txt.replace(/^\s*```(?:json)?|```\s*$/g, '').trim());
        if (P.ok(o)) result = o;
      } catch { /* retry */ }
    }
  } catch (e) {
    console.error('ai error', e && e.message);
    return fail(502, 'ai', GENERIC);
  }
  if (result === undefined) return fail(502, 'ai', GENERIC);

  // 5. Save under the user's own account
  const rows = isChat
    ? ['chat_messages', [{ user_id: user.id, role: 'user', content: input }, { user_id: user.id, role: 'assistant', content: result }]]
    : ['analyses', { user_id: user.id, type: feature, input: input.slice(0, 4000), result }];
  await rest(rows[0], { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(rows[1]) });
  return J({ result });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/config') return J({ url: env.SUPABASE_URL, key: env.SUPABASE_ANON_KEY });
    if (pathname === '/api/ai' && request.method === 'POST') {
      try { return await handleAi(request, env); }
      catch (e) { console.error('server error', e && e.message); return fail(500, 'server', GENERIC); }
    }
    return env.ASSETS.fetch(request);
  },
};
