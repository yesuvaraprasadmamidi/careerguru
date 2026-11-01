// CareerGuru AI backend (Cloudflare Pages advanced mode).
// Secrets (GEMINI_API_KEY etc.) live only in Cloudflare environment variables.
const A = x => (Array.isArray(x) ? x : []);
// Two reply styles: pure English, or Telugu-English mix (Tanglish). Older saved values map to the mix.
const LANG_NOTE = {
  'English': 'simple, clear English',
  'Telugu-English mix': 'Tanglish: Telugu words written in English (Roman) letters mixed naturally with English, the way Telugu students talk. Keep technical terms, job titles and skill names in English',
};
const normLang = x => (/telugu|hinglish/i.test(String(x || '')) ? 'Telugu-English mix' : 'English');
const GENERIC = 'We couldn’t complete the analysis right now. Please try again.';
const J = (o, s = 200) => Response.json(o, { status: s, headers: { 'Cache-Control': 'no-store' } });
const fail = (s, code, error, detail) => J({ code, error, detail }, s);

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
  resume_build: {
    sys: 'You are an expert ATS resume writer for Indian freshers. Build a one-page resume tailored to the job description, using ONLY facts the candidate gave. Never invent employers, dates, numbers, links, certifications or skills. If a detail is missing, leave that field empty (or the array empty). Start each bullet with a strong verb and keep it under 22 words. Use exact keywords from the job description wherever the candidate facts truthfully support them. Group skills into 3 to 5 labelled lines. keywords: the 12 to 20 most important skills and tools named in the job description.',
    shape: '{\"title\":str(target job title),\"summary\":str(max 45 words),\"skills\":[{\"l\":str,\"items\":[str]}],\"experience\":[{\"role\":str,\"org\":str,\"dates\":str,\"bullets\":[str]}],\"projects\":[{\"name\":str,\"stack\":str,\"link\":str,\"bullets\":[str]}],\"education\":[{\"degree\":str,\"school\":str,\"dates\":str,\"cgpa\":str}],\"certs\":[str],\"achievements\":[str],\"keywords\":[str]}',
    ok: o => o && typeof o.summary === 'string' && Array.isArray(o.skills) && o.skills.length > 0 && Array.isArray(o.keywords),
  },
  job: {
    sys: 'You are a recruiter-minded job match analyst. Compare the candidate to the job description honestly and specifically.',
    shape: '{"match":0-100,"breakdown":{"Technical skills":n,"Education":n,"Experience":n,"Soft skills":n,"Keywords":n},"required":[str],"missing":[str],"keywords":[str],"strong_because":str,"may_reject_because":str,"plan":[str]}',
    ok: o => o && typeof o.match === 'number' && o.breakdown && typeof o.breakdown === 'object',
  },
  chat: {
    sys: 'You are CareerGuru AI, a personal career mentor for Indian students and freshers, not a generic chatbot. Cover only career topics (jobs, skills, resume, interviews, projects, learning, placements, LinkedIn); politely steer anything else back. Personalize using the profile. Be concise: bold short headings, bullets, and one clear next step. Never write long blocks.',
  },
  iv_start: {
    sys: 'You are a friendly but professional interviewer for Indian students and freshers. Ask the FIRST interview question for the given role, level, difficulty and interview type. Ask exactly one question, written in English (interviews are in English); write the tip in the requested language.',
    shape: '{"question":str,"tip":str(one short hint on how to structure the answer, max 20 words)}',
    ok: o => o && typeof o.question === 'string' && o.question.length > 5,
  },
  iv_turn: {
    sys: 'You are an interview coach for Indian freshers. Evaluate the candidate latest answer honestly but kindly, with a score out of 10 (be strict: vague or very short answers score low). Then write the NEXT question on a different topic, unless QUESTION_NUMBER equals TOTAL, in which case next_question must be null. Keep next_question in English (interviews are in English) and write all feedback fields in the requested language.',
    shape: '{"score":0-10 number,"good":[str],"missing":[str],"improve":[str],"better_answer":str(a short model answer outline, max 60 words),"next_question":str|null,"next_tip":str|null}',
    ok: o => o && typeof o.score === 'number' && Array.isArray(o.good) && Array.isArray(o.missing),
  },
  iv_report: {
    sys: 'You are an interview coach. Write the final interview report from the questions, answers and scores. Be specific and encouraging.',
    shape: '{"overall":0-100,"verdict":str(max 30 words),"strong":[str],"weak":[str],"practice_topics":[str],"practice_questions":[str]}',
    ok: o => o && typeof o.overall === 'number' && Array.isArray(o.weak),
  },
};

async function gemini(env, prompt, json, part) {
  // Tries each model in order, so a retired or busy model never takes the app down.
  // Override with the GEMINI_MODEL variable (comma-separated model names).
  const models = (env.GEMINI_MODEL || 'gemini-flash-latest,gemini-3-flash-preview,gemini-3.1-flash-lite')
    .split(',').map(s => s.trim()).filter(Boolean);
  let last;
  for (const model of models) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ parts: [...(part ? [part] : []), { text: prompt }] }],
          generationConfig: json ? { responseMimeType: 'application/json' } : {},
        }),
        signal: AbortSignal.timeout(40000),
      });
      if (!r.ok) throw new Error(model + ' ' + r.status + ' ' + (await r.text()).replace(/\s+/g, ' ').slice(0, 160));
      const d = await r.json();
      const txt = A(d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts)
        .map(p => p.text || '').join('');
      if (!txt.trim()) throw new Error(model + ' returned empty text');
      return txt;
    } catch (e) { last = e; }
  }
  throw last;
}

async function handleAi(request, env) {
  const url = env.SUPABASE_URL, key = env.SUPABASE_ANON_KEY;
  if (!url || !key || !env.GEMINI_API_KEY) return fail(500, 'config', 'The server is not configured yet.');
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer /, '');
  if (!token) return fail(401, 'auth', 'Please log in.');
  let body;
  try { body = await request.json(); } catch { return fail(400, 'input', 'Invalid request.'); }
  const { feature, input, history, profile, file } = body || {};
  if (!Object.prototype.hasOwnProperty.call(PROMPTS, feature)) return fail(400, 'input', 'Unknown feature.');
  const isChat = feature === 'chat';
  if (typeof input !== 'string' || !input.trim() || input.length > (isChat ? 2000 : 14000)) {
    return fail(400, 'input', 'Please check your input and try again.');
  }
  // Optional PDF resume (resume feature only). Gemini reads the PDF itself.
  let part = null;
  if (file) {
    if (feature !== 'resume' || file.mime !== 'application/pdf' || typeof file.data !== 'string' || file.data.length > 2200000) {
      return fail(400, 'input', 'Please upload a PDF under 1.5 MB.');
    }
    part = { inline_data: { mime_type: 'application/pdf', data: file.data } };
  }
  const lang = normLang(body.lang);
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

  // 2. Plan and free-tier limits
const paidPlansEnabled = false;
let pro = false;

if (paidPlansEnabled) {
  const subs = await (await rest('subscriptions?select=plan_id,status,expiry_date&limit=1')).json();
  const sub = A(subs)[0];
  pro = !!(sub && sub.plan_id !== 'free' &&
    sub.status === 'active' &&
    (!sub.expiry_date || new Date(sub.expiry_date) > new Date()));
}

const lkey = feature === 'iv_start' ? 'interview' : feature;

if (!pro && (!feature.startsWith('iv_') || feature === 'iv_start')) {
  const plan = A(await (await rest('plans?id=eq.free&select=limits')).json())[0];
  const lim = (plan && plan.limits) || {};
  const max = isChat ? lim.chat_per_day : lim[lkey];

  if (max != null) {
    // India midnight (IST) reset
    const ist = new Date(Date.now() + 330 * 60 * 1000);
    ist.setUTCHours(0, 0, 0, 0);
    const since = new Date(ist.getTime() - 330 * 60 * 1000);

    const q = isChat
      ? 'chat_messages?select=id&role=eq.user&created_at=gte.' + since.toISOString()
      : 'analyses?select=id&type=eq.' + lkey +
        '&created_at=gte.' + since.toISOString();

    const cr = await rest(q, {
      headers: { Prefer: 'count=exact', Range: '0-0' }
    });

    const used = +((cr.headers.get('content-range') || '').split('/')[1]) || 0;

    if (used >= max) {
      return fail(429, 'limit', isChat
        ? `You've used your ${max} free chat questions for today. Please come back tomorrow.`
        : `You've used your ${max} free ${lkey === 'interview' ? 'interview practice sessions' : lkey === 'resume_build' ? 'resume builds' : lkey + ' analyses'} today. Please come back tomorrow.`);
    }
  }
}

  // Interview turns and reports must belong to a real, recent session of this user
  if (feature === 'iv_turn' || feature === 'iv_report') {
    const sid = String(body.session || '');
    if (!/^[0-9a-f-]{36}$/.test(sid)) return fail(400, 'input', 'Interview session missing. Please start again.');
    const sr = A(await (await rest('analyses?select=id,created_at&id=eq.' + sid + '&type=eq.interview&limit=1')).json())[0];
    if (!sr || Date.now() - new Date(sr.created_at).getTime() > 4 * 3600 * 1000) return fail(400, 'input', 'This interview session has expired. Please start a new one.');
  }

  // 3. Build the prompt for this feature
  let prompt;
  if (isChat) {
    const h = A(history).slice(-10)
      .map(x => (x && x.r === 'u' ? 'Student: ' : 'Mentor: ') + String((x && x.t) || '').slice(0, 1500)).join('\n');
    prompt = `${P.sys}\nWrite in ${LANG_NOTE[lang]}.\n\nPROFILE:\n${String(profile || '').slice(0, 2000) || '(not provided)'}\n\nCHAT SO FAR:\n${h}\nStudent: ${input}\nMentor:`;
  } else {
    prompt = `${P.sys}\nWrite all text values in ${feature === 'resume_build' ? LANG_NOTE.English : LANG_NOTE[lang]}; keep JSON keys in English. Return ONLY valid JSON.\n\nSCHEMA: ${P.shape}${part ? '\nAlso add a top-level field \"resume_text\" with the resume plain text (max 4000 characters).' : ''}\n\nDATA:\n${input}`;
  }

  // 4. Call the AI; JSON features are validated, with one retry
  let result;
  try {
    for (let i = 0; i < 2 && result === undefined; i++) {
      const txt = await gemini(env, prompt, !isChat, part);
      if (isChat) { if (txt.trim()) result = txt.trim(); continue; }
      try {
        const o = JSON.parse(txt.replace(/^\s*```(?:json)?|```\s*$/g, '').trim());
        if (P.ok(o)) result = o;
      } catch { /* retry */ }
    }
  } catch (e) {
    console.error('ai error', e && e.message);
    return fail(502, 'ai', GENERIC, String((e && e.message) || e).slice(0, 220));
  }
  if (result === undefined) return fail(502, 'ai', GENERIC, 'The AI returned an unusable answer. Try again.');

  if (feature === 'iv_turn') return J({ result });
  if (feature === 'iv_report') {
    await rest('analyses?id=eq.' + body.session, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ result }) });
    return J({ result });
  }
  if (feature === 'iv_start') {
    const ir = await rest('analyses', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ user_id: user.id, type: 'interview', input: input.slice(0, 2000), result }) });
    const row = A(await ir.json())[0];
    if (!row) return fail(500, 'ai', GENERIC);
    return J({ result: { ...result, session: row.id } });
  }

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
