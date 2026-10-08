// 현장 대화(공간 Talk) · 버그 제보 → 웹 푸시(VAPID) 전송
//  GET                : VAPID 공개키 반환 (없으면 생성해 push_config 에 저장 — 비밀키는 DB 밖으로 나가지 않음)
//  POST {message_id}  : DB 트리거(pg_net)가 호출. 근무시간(평일 08~17 KST, 공휴일 제외)에만 즉시 전송, 그 외에는 'deferred' 표시만
//  POST {digest:true} : pg_cron 이 평일 08:30 KST 에 호출. 보류된 메시지를 사용자별로 묶어 "n건 왔어요" 한 번 전송 (dry:true 면 집계만)
//  POST {feedback_id} : 버그 제보 → 운영자 기기로 즉시. event:'reply' 이면 제보자에게 답변·상태 변경 알림 (근무시간 무관)
//  POST {test:true}   : 로그인 사용자 본인 기기로 테스트 알림 (Authorization: Bearer <user jwt>) — 근무시간 무관
// 수신자는 RPC push_recipients 가 판정(직원 + 건축주톡이면 연결된 건축주), pushed_at 으로 중복 방지.
// 건축주(owner_users)에게는 건축주 앱용 문구·주소(url)로, 직원에게는 관리자 앱용(hash)으로 보냄
// 인증 없이 호출돼도 할 수 있는 일은 "이미 저장된 행의 정당한 수신자에게 푸시"뿐이라 공개 호출 허용
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import * as webpush from "jsr:@negrel/webpush@0.5.0";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_URL = Deno.env.get("APP_URL") ?? "https://bm-admin-neon.vercel.app";
const sb = createClient(URL_, SERVICE, { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

let appServer: webpush.ApplicationServer | null = null;
let publicKey = "";

async function loadConfig(): Promise<Record<string, string>> {
  const { data, error } = await sb.from("push_config").select("key, value").in("key", ["vapid_keys", "vapid_public"]);
  if (error) throw error;
  return Object.fromEntries((data ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));
}
async function ensureKeys() {
  if (appServer) return;
  let cfg = await loadConfig();
  if (!cfg.vapid_keys) {
    const keys = await webpush.generateVapidKeys({ extractable: true });
    const exported = await webpush.exportVapidKeys(keys);
    const pub = await webpush.exportApplicationServerKey(keys);
    const { error } = await sb.from("push_config").insert([
      { key: "vapid_keys", value: JSON.stringify(exported) },
      { key: "vapid_public", value: pub },
    ]);
    if (error) console.warn("vapid insert (race?):", error.message);
    cfg = await loadConfig();
  }
  publicKey = cfg.vapid_public;
  const vapidKeys = await webpush.importVapidKeys(JSON.parse(cfg.vapid_keys), { extractable: false });
  appServer = await webpush.ApplicationServer.new({ contactInformation: APP_URL, vapidKeys });
}
async function isWorkTime(): Promise<boolean> {
  const { data, error } = await sb.rpc("is_work_time");
  if (error) throw error;
  return !!data;
}

type Sub = { user_id: string; sub_id: number; endpoint: string; p256dh: string; auth: string };
type Payload = { title: string; body: string; tag: string; hash: string; call: boolean; bm_key?: string; id?: number; url?: string };
const emptyRes = () => ({ sent: 0, gone: 0, failed: 0, errors: [] as string[] });
const addRes = (a: ReturnType<typeof emptyRes>, b: ReturnType<typeof emptyRes>) => ({ sent: a.sent + b.sent, gone: a.gone + b.gone, failed: a.failed + b.failed, errors: [...a.errors, ...b.errors] });
const shorten = (s: string, n = 90) => { const t = (s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };

async function sendTo(subs: Sub[], payload: Payload, opts: webpush.PushMessageOptions) {
  const out = emptyRes();
  const text = JSON.stringify(payload);
  await Promise.all(subs.map(async (s) => {
    try {
      const subscriber = appServer!.subscribe({ endpoint: s.endpoint, keys: { auth: s.auth, p256dh: s.p256dh } });
      await subscriber.pushTextMessage(text, opts);
      out.sent++;
    } catch (e) {
      const status = e instanceof webpush.PushMessageError ? e.response.status : 0;
      if (status === 404 || status === 410) {
        out.gone++;
        await sb.from("push_subscriptions").delete().eq("id", s.sub_id);
      } else {
        out.failed++;
        out.errors.push(`${status || "err"}: ${String(e).slice(0, 120)}`);
        await sb.rpc("push_fail", { p_id: s.sub_id });
      }
    }
  }));
  return out;
}
const toSubs = (rows: { user_id: string; id: number; endpoint: string; p256dh: string; auth: string }[] | null) =>
  (rows ?? []).map((r) => ({ user_id: r.user_id, sub_id: r.id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }));
async function subsOf(userIds: string[], endpoint?: string): Promise<Sub[]> {
  if (!userIds.length) return [];
  let q = sb.from("push_subscriptions").select("user_id, id, endpoint, p256dh, auth").in("user_id", userIds);
  if (endpoint) q = q.eq("endpoint", endpoint);
  const { data, error } = await q;
  if (error) throw error;
  return toSubs(data);
}
// 수신자 중 건축주 계정
async function ownerIds(userIds: string[]): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  const { data } = await sb.from("owner_users").select("user_id").in("user_id", userIds);
  return new Set((data ?? []).map((r: { user_id: string }) => r.user_id));
}

async function handleMessage(id: number) {
  // 근무시간 밖: 보류 표시만 (pushed_at 은 비워 둠 → 아침 요약이 집계)
  if (!(await isWorkTime())) {
    const { data } = await sb.from("site_messages").update({ push_result: "deferred" }).eq("id", id).is("pushed_at", null).select("id");
    return json({ deferred: !!data?.length });
  }
  const { data: msg, error } = await sb.from("site_messages")
    .update({ pushed_at: new Date().toISOString() })
    .eq("id", id).is("pushed_at", null)
    .select("id, bm_key, channel, sender_name, sender_role, target_role, call_owner, body, user_id").maybeSingle();
  if (error) throw error;
  if (!msg) return json({ skipped: "already handled" });

  const [{ data: site }, { data: subs, error: e2 }] = await Promise.all([
    sb.from("sites").select("issue_name").eq("bm_key", msg.bm_key).maybeSingle(),
    sb.rpc("push_recipients", { p_message_id: id }),
  ]);
  if (e2) throw e2;

  const siteName = site?.issue_name || msg.bm_key;
  const short = shorten(msg.body) || "📎 첨부 파일";
  const ownerCh = msg.channel === "owner";
  const list: Sub[] = subs ?? [];
  const owners = await ownerIds([...new Set(list.map((s) => s.user_id))]);
  const ownerSubs = list.filter((s) => owners.has(s.user_id)), staffSubs = list.filter((s) => !owners.has(s.user_id));
  const topic = String(msg.bm_key).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || undefined;

  // 직원(관리자 앱)
  const staffCall = !!msg.target_role;
  const staffPayload: Payload = {
    title: staffCall ? `📣 ${siteName} · ${msg.target_role} 호출${ownerCh ? " (건축주톡)" : ""}` : ownerCh ? `${siteName} · 건축주톡` : siteName,
    body: `${msg.sender_name}${ownerCh && msg.sender_role === "건축주" ? "(건축주)" : ""}: ${short}`,
    tag: `site-${msg.bm_key}`,
    hash: `#site/${encodeURIComponent(msg.bm_key)}`,
    call: staffCall, bm_key: msg.bm_key, id: msg.id,
  };
  // 건축주(건축주 앱): 그 현장 공간 Talk로 바로 열리게
  const ownerCall = !!msg.call_owner;
  const ownerPayload: Payload = {
    title: ownerCall ? `📣 ${siteName} · 건축주님 호출` : `${siteName} · 공간 Talk`,
    body: `${msg.sender_name}${msg.sender_role && msg.sender_role !== "건축주" ? `(${msg.sender_role})` : ""}: ${short}`,
    tag: `talk-${msg.bm_key}`,
    hash: "", url: `./?talk=${encodeURIComponent(msg.bm_key)}`,
    call: ownerCall, bm_key: msg.bm_key, id: msg.id,
  };
  let res = emptyRes();
  if (staffSubs.length) res = addRes(res, await sendTo(staffSubs, staffPayload, { ttl: 86400, urgency: staffCall ? webpush.Urgency.High : webpush.Urgency.Normal, topic }));
  if (ownerSubs.length) res = addRes(res, await sendTo(ownerSubs, ownerPayload, { ttl: 86400, urgency: ownerCall ? webpush.Urgency.High : webpush.Urgency.Normal, topic: topic ? `t${topic}`.slice(0, 32) : undefined }));
  const summary = `recipients ${list.length} (owners ${ownerSubs.length}), sent ${res.sent}, gone ${res.gone}, failed ${res.failed}` + (res.errors.length ? " | " + res.errors.join("; ").slice(0, 300) : "");
  await sb.from("site_messages").update({ push_result: summary }).eq("id", id);
  console.log(JSON.stringify({ message_id: id, ...res, recipients: list.length, owners: ownerSubs.length }));
  return json({ ok: true, recipients: list.length, owners: ownerSubs.length, ...res });
}

// 아침 요약: 보류된 메시지를 사용자별로 묶어 한 번에. 이미 읽은 것은 RPC가 제외
type DigestRow = { user_id: string; n: number; sites: number; calls: number };
async function handleDigest(dry: boolean) {
  const work = await isWorkTime();
  if (!work && !dry) return json({ skipped: "not work time" });
  const { data, error } = await sb.rpc("digest_pending");
  if (error) throw error;
  const rows: DigestRow[] = data ?? [];
  if (dry) return json({ dry: true, work_time: work, users: rows });
  const owners = await ownerIds(rows.map((r) => r.user_id));
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    const subs = await subsOf([r.user_id]);
    if (!subs.length) { out.push({ user: r.user_id, devices: 0 }); continue; }
    const n = Number(r.n), sites = Number(r.sites), calls = Number(r.calls);
    const payload: Payload = owners.has(r.user_id)
      ? { title: "공간 Talk", body: `담당자에게서 새 메시지 ${n}건이 왔어요`, tag: "digest-talk", hash: "", url: "./", call: false }
      : {
        title: "공간제작소 관리자",
        body: `근무시간 외에 새 메시지 ${n}건이 왔어요 (현장 ${sites}곳${calls ? `, 📣 호출 ${calls}건 포함` : ""})`,
        tag: "digest", hash: "#sites", call: calls > 0,
      };
    const res = await sendTo(subs, payload, { ttl: 6 * 3600, urgency: calls ? webpush.Urgency.High : webpush.Urgency.Normal, topic: "digest" });
    out.push({ user: r.user_id, devices: subs.length, n, sites, calls, owner: owners.has(r.user_id), ...res });
  }
  const { data: marked } = await sb.from("site_messages").update({ pushed_at: new Date().toISOString(), push_result: "digest" }).is("pushed_at", null).eq("push_result", "deferred").select("id");
  console.log(JSON.stringify({ digest: out, marked: marked?.length ?? 0 }));
  return json({ ok: true, users: out, marked: marked?.length ?? 0 });
}

// 버그 제보: 새 제보 → 운영자(owner) 전원 / 답변·상태 변경 → 제보자
const KIND: Record<string, string> = { bug: "버그", improve: "개선 요청", question: "질문" };
const STATUS: Record<string, string> = { open: "접수", doing: "처리 중", done: "완료" };
async function handleFeedback(id: number, event?: string) {
  if (event === "reply") {
    const { data: fb, error } = await sb.from("feedback").select("id, user_id, kind, status, reply, body").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!fb) return json({ skipped: "not found" });
    const subs = await subsOf([fb.user_id]);
    const payload: Payload = {
      title: `🐞 제보 ${STATUS[fb.status] ?? fb.status} · ${KIND[fb.kind] ?? fb.kind}`,
      body: fb.reply ? shorten(fb.reply) : `"${shorten(fb.body, 50)}" 제보가 ${STATUS[fb.status] ?? fb.status} 상태로 바뀌었어요`,
      tag: `feedback-${fb.id}`, hash: "#feedback", call: false,
    };
    const res = subs.length ? await sendTo(subs, payload, { ttl: 86400, urgency: webpush.Urgency.Normal }) : emptyRes();
    return json({ ok: true, to: "reporter", devices: subs.length, ...res });
  }
  const { data: fb, error } = await sb.from("feedback").update({ pushed_at: new Date().toISOString() }).eq("id", id).is("pushed_at", null)
    .select("id, user_id, kind, body, page").maybeSingle();
  if (error) throw error;
  if (!fb) return json({ skipped: "already handled" });
  const [{ data: who }, { data: owners }] = await Promise.all([
    sb.from("admin_users").select("staff_name, google_name, email").eq("id", fb.user_id).maybeSingle(),
    sb.from("admin_users").select("id").eq("role", "owner"),
  ]);
  const name = who?.staff_name || who?.google_name || who?.email || "직원";
  const subs = await subsOf((owners ?? []).map((o: { id: string }) => o.id).filter((x: string) => x !== fb.user_id));
  const payload: Payload = {
    title: `🐞 새 제보 · ${KIND[fb.kind] ?? fb.kind}`,
    body: `${name}: ${shorten(fb.body)}`,
    tag: "feedback-new", hash: "#users", call: false,
  };
  const res = subs.length ? await sendTo(subs, payload, { ttl: 86400, urgency: webpush.Urgency.High }) : emptyRes();
  console.log(JSON.stringify({ feedback_id: id, ...res }));
  return json({ ok: true, to: "owner", devices: subs.length, ...res });
}

async function handleTest(req: Request, body: { endpoint?: string }) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "unauthorized" }, 401);
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) return json({ error: "unauthorized" }, 401);
  const subs = await subsOf([user.id], body.endpoint);
  const isOwner = (await ownerIds([user.id])).has(user.id);
  const payload: Payload = isOwner
    ? { title: "공간 Talk", body: "알림이 정상적으로 설정되었습니다 ✅", tag: "test", hash: "", url: "./", call: false }
    : { title: "공간제작소 관리자", body: "알림이 정상적으로 설정되었습니다 ✅", tag: "test", hash: "#notify", call: false };
  const res = await sendTo(subs, payload, { ttl: 300, urgency: webpush.Urgency.High });
  return json({ ok: true, devices: subs.length, ...res });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    await ensureKeys();
    if (req.method === "GET") return json({ publicKey });
    const body = await req.json().catch(() => ({}));
    if (body.test) return await handleTest(req, body);
    if (body.digest) return await handleDigest(!!body.dry);
    if (body.feedback_id) return await handleFeedback(Number(body.feedback_id), body.event);
    if (body.message_id) return await handleMessage(Number(body.message_id));
    return json({ error: "bad request" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
