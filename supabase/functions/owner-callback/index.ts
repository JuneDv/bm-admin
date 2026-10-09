// 건축주 앱 '전화 요청' (설계·인테리어 담당자에게 메일로 전달)
//  ※ 현재 건축주 앱에는 '전화 요청' 버튼이 없음 (담당자 번호로 바로 '연결'하는 방식으로 바뀜). 다시 쓰려면
//     건축주 앱에서 이 함수를 부르고, n8n '[공정모니터링] BM 전화요청 웹훅' 워크플로를 다시 켜면 됨 (지금은 꺼 둠)
//  POST { bm_key, target: 'design'|'interior', message }  + Authorization: Bearer <건축주 access token>
//   - 로그인한 건축주가 연결된 현장에 대해서만 (예전엔 n8n 웹훅을 누구나 직접 불러 임의 번호·현장으로 요청을 넣을 수 있었음)
//   - 근무시간(평일 08~17, 공휴일 제외)에만 접수. 담당자 번호는 staff 표에서 찾아 gg<뒷4자리>@gg-arch.co.kr 로 보냄
//   - 실제 메일 발송은 n8n 웹훅(bm-callback)이 하고, 이 함수만 비밀 헤더로 부를 수 있음
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const HOOK = Deno.env.get("CALLBACK_HOOK_URL") ?? "https://tareura.app.n8n.cloud/webhook/bm-callback";
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const LABEL: Record<string, string> = { design: "설계", interior: "인테리어" };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "bad request" }, 400);
  try {
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const { data: { user } } = await admin.auth.getUser(token);
    const { data: owner } = user ? await admin.from("owner_users").select("user_id, phone, name").eq("user_id", user.id).maybeSingle() : { data: null };
    if (!owner) return json({ ok: false, message: "다시 접속해 주세요." }, 401);

    const body = await req.json().catch(() => ({}));
    const bmKey = String(body.bm_key ?? "").trim();
    const target = body.target === "interior" ? "interior" : "design";
    const message = String(body.message ?? "").trim().slice(0, 500);
    const { data: link } = await admin.from("owner_sites").select("bm_key").eq("user_id", owner.user_id).eq("bm_key", bmKey).maybeSingle();
    if (!bmKey || !link) return json({ ok: false, message: "현장 정보를 확인할 수 없습니다." }, 403);

    const { data: work } = await admin.rpc("is_work_time");
    if (!work) return json({ ok: false, message: "지금은 근무시간이 아닙니다.\n평일 오전 8시~오후 5시에 요청해 주세요." });

    const { data: site } = await admin.from("sites").select("issue_name, site_address, owner_name, designer, interior").eq("bm_key", bmKey).is("archived_at", null).maybeSingle();
    if (!site) return json({ ok: false, message: "현장 정보를 확인할 수 없습니다." }, 404);
    const person = String((target === "interior" ? site.interior : site.designer) ?? "").trim();
    const { data: st } = person && person !== "-" ? await admin.from("staff").select("phone").eq("name", person).maybeSingle() : { data: null };
    const pPhone = String(st?.phone ?? "").replace(/[^0-9]/g, "");
    if (!person || person === "-" || pPhone.length < 4) return json({ ok: false, message: "담당자 정보를 찾을 수 없습니다.\n대표 담당자에게 연락해 주세요." });

    const { data: key, error: eKey } = await admin.rpc("internal_secret", { p_name: "callback_webhook_key" });
    if (eKey || !key) throw eKey ?? new Error("callback key missing");
    const when = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
    const label = LABEL[target];
    const payload = {
      email: `gg${pPhone.slice(-4)}@gg-arch.co.kr`,
      subject: `[전화 요청] ${site.issue_name || site.site_address || bmKey} 건축주 (${label})`,
      text: `건축주 ${site.owner_name || owner.name || ""} 님이 ${label} 담당 통화를 요청했습니다.\n\n연락처: ${owner.phone}\n현장: ${site.site_address || ""}\nBM: ${bmKey}${message ? `\n남기신 말씀: ${message}` : ""}\n요청 시각: ${when}\n\n근무시간 내에 회신 부탁드립니다.`,
    };
    const res = await fetch(HOOK, { method: "POST", headers: { "Content-Type": "application/json", "x-callback-key": String(key) }, body: JSON.stringify(payload) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) { console.error("hook", res.status, JSON.stringify(out).slice(0, 200)); return json({ ok: false, message: "요청 전송에 실패했습니다. 잠시 후 다시 시도해 주세요." }, 502); }
    console.log(JSON.stringify({ callback: bmKey, target, to: payload.email }));
    return json({ ok: true, message: "요청이 접수되었습니다.\n담당자가 곧 연락드리겠습니다." });
  } catch (e) {
    console.error(e);
    return json({ ok: false, message: "요청 전송에 실패했습니다. 잠시 후 다시 시도해 주세요." }, 500);
  }
});
