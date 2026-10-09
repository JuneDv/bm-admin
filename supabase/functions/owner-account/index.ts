// 건축주 계정 관리 (건축주 앱 '내 정보')
//  POST { action: 'signout_others' } : 이 기기만 남기고 같은 계정의 다른 기기 접속 해제
//  POST { action: 'delete' }         : 계정 삭제 — 이 번호로 접속한 모든 기기에서 해제
//    · 지우는 것: 현장 연결(owner_sites), 알림 등록, 기기 호칭, 접속 기록, 건축주 정보(owner_users)
//    · 대화 내용은 현장 기록이라 남기고 보낸 사람 이름만 '탈퇴한 건축주'로 바꿈
//    · 로그인 계정은 개인정보(전화번호가 든 이메일·이름)를 지우고 영구 차단 — 대화 기록이 계정에 묶여 있어 행은 남김
//    · 다시 계약번호로 접속하면 새 계정으로 시작
//  Authorization: Bearer <건축주 access token> 필수
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "bad request" }, 400);
  try {
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const { data: { user }, error: eu } = await admin.auth.getUser(token);
    if (eu || !user) return json({ error: "다시 접속해 주세요." }, 401);
    const { data: owner } = await admin.from("owner_users").select("user_id, phone").eq("user_id", user.id).maybeSingle();
    if (!owner) return json({ error: "건축주 계정이 아니에요." }, 403);
    const { action } = await req.json().catch(() => ({}));

    if (action === "signout_others") {
      const { error } = await admin.auth.admin.signOut(token, "others");
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "delete") {
      const uid = user.id;
      await admin.from("site_messages").update({ sender_name: "탈퇴한 건축주" }).eq("user_id", uid);
      await admin.from("push_subscriptions").delete().eq("user_id", uid);
      await admin.from("owner_session_prefs").delete().eq("user_id", uid);
      await admin.from("owner_sites").delete().eq("user_id", uid);
      await admin.from("owner_login_attempts").delete().eq("phone", owner.phone);
      await admin.from("owner_users").delete().eq("user_id", uid);
      await admin.auth.admin.signOut(token, "global");
      const { error } = await admin.auth.admin.updateUserById(uid, {
        email: `deleted-${uid}@owner.invalid`,
        user_metadata: { name: null, phone: null }, app_metadata: { kind: "owner_deleted" },   // 메타데이터는 합쳐지므로 값을 비움
        ban_duration: "876000h",
      });
      if (error) throw error;
      console.log(JSON.stringify({ deleted_owner: uid }));
      return json({ ok: true });
    }
    return json({ error: "bad request" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "처리 중 오류가 났어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
});
