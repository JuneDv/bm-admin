// 매일 정리 (pg_cron → 이 함수, x-internal-key 로 확인)
//  · 건축주 로그인 시도 기록 30일 지난 것 (전화번호·IP가 들어 있어 오래 두지 않음)
//  · 지난 미리보기 확인값 (10분짜리, 하루 지난 것)
//  · Jira 웹훅 이벤트 로그 90일 지난 것
//  · 보관된 지 1년 넘은 현장의 대화 첨부 파일 (storage 에서 지우고 message_files.deleted_at 표시 — 대화 글은 남김)
//  · 보관된 지 10년 넘은 현장의 대화 (개인정보처리방침: 공사 완료 후 10년)
//  · 처리 완료 후 3년 지난 건축주 관리자 문의 (개인정보처리방침)
//  POST {dry:true} 면 지울 개수만 돌려줌
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(URL_, SERVICE, { auth: { persistSession: false } });
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString();

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "bad request" }, 400);
  const { data: key } = await sb.rpc("internal_secret", { p_name: "push_internal_key" });
  const got = req.headers.get("x-internal-key") ?? "";
  if (!key || got.length !== String(key).length || got !== key) return json({ error: "unauthorized" }, 401);
  const body = await req.json().catch(() => ({}));
  const dry = !!body.dry;
  const out: Record<string, unknown> = { dry };
  try {
    const count = async (table: string, f: (q: any) => any) => { const { count } = await f(sb.from(table).select("*", { count: "exact", head: true })); return count ?? 0; };
    const del = async (table: string, f: (q: any) => any) => { const { data, error } = await f(sb.from(table).delete()).select("*"); if (error) throw error; return data?.length ?? 0; };

    out.login_attempts = dry ? await count("owner_login_attempts", (q) => q.lt("at", daysAgo(30))) : await del("owner_login_attempts", (q) => q.lt("at", daysAgo(30)));
    out.preview_tickets = dry ? await count("preview_tickets", (q) => q.lt("expires_at", daysAgo(1))) : await del("preview_tickets", (q) => q.lt("expires_at", daysAgo(1)));
    out.jira_events = dry ? await count("jira_events", (q) => q.lt("received_at", daysAgo(90))) : await del("jira_events", (q) => q.lt("received_at", daysAgo(90)));

    // 보관 1년 넘은 현장의 첨부 파일
    const { data: oldSites } = await sb.from("sites").select("bm_key").lt("archived_at", daysAgo(365));
    const keys = (oldSites ?? []).map((s: { bm_key: string }) => s.bm_key);
    let files = 0;
    if (keys.length) {
      const { data: fl } = await sb.from("message_files").select("id, path").in("bm_key", keys).is("deleted_at", null).limit(500);
      files = fl?.length ?? 0;
      if (!dry && fl?.length) {
        const { error: eRm } = await sb.storage.from("chat-files").remove(fl.map((f: { path: string }) => f.path));
        if (eRm) throw eRm;
        await sb.from("message_files").update({ deleted_at: new Date().toISOString(), deleted_reason: "archived_1y" }).in("id", fl.map((f: { id: number }) => f.id));
      }
    }
    out.archived_site_files = files;

    // 보관 10년 넘은 현장의 대화 — 남은 첨부를 storage 에서 지운 뒤 글 삭제(첨부 행은 함께 지워짐)
    const { data: oldSites10 } = await sb.from("sites").select("bm_key").lt("archived_at", daysAgo(3650));
    const keys10 = (oldSites10 ?? []).map((s: { bm_key: string }) => s.bm_key);
    let msgs = 0;
    if (keys10.length) {
      msgs = await count("site_messages", (q) => q.in("bm_key", keys10));
      if (!dry && msgs) {
        const { data: fl } = await sb.from("message_files").select("path").in("bm_key", keys10).is("deleted_at", null);
        if (fl?.length) { const { error: eRm } = await sb.storage.from("chat-files").remove(fl.map((f: { path: string }) => f.path)); if (eRm) throw eRm; }
        msgs = await del("site_messages", (q) => q.in("bm_key", keys10));
      }
    }
    out.archived_site_messages_10y = msgs;

    // 처리 완료 후 3년 지난 건축주 문의
    const oldInq = (q: any) => q.eq("page", "owner-app").eq("status", "done").lt("updated_at", daysAgo(365 * 3));
    out.owner_inquiries_3y = dry ? await count("feedback", oldInq) : await del("feedback", oldInq);
    console.log(JSON.stringify(out));
    return json(out);
  } catch (e) {
    console.error(e);
    return json({ error: String(e), ...out }, 500);
  }
});
