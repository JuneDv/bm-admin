// 공간 Talk 건축주 접속: 전화번호 + 계약번호 → 건축주 계정 세션 발급
//  POST { phone, contract }
//   - 두 값이 같은 현장(sites.phones ∋ phone, sites.contract_no = contract)에 있으면
//     건축주 계정(없으면 생성, app_metadata.kind='owner')으로 로그인 세션을 돌려주고 그 현장을 계정에 연결
//   - 틀린 시도: 같은 번호 1시간 5회 / 같은 IP 1시간 30회 넘으면 잠시 막음
//  계정 이메일은 실제로 쓰이지 않는 주소(…@owner.invalid), 비밀번호는 접속마다 새로 만들어 서버만 앎
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
const PHONE_FAIL_MAX = 5, IP_FAIL_MAX = 30;

const randomPassword = () => {
  const b = new Uint8Array(24); crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b));
};

async function failures(col: "phone" | "ip", v: string) {
  if (!v) return 0;
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await admin.from("owner_login_attempts").select("id", { count: "exact", head: true })
    .eq(col, v).eq("ok", false).gte("at", since);
  return count ?? 0;
}

async function ownerUserId(phone: string, name: string | null): Promise<string> {
  const { data: found } = await admin.from("owner_users").select("user_id").eq("phone", phone).maybeSingle();
  if (found) return found.user_id;
  const email = `${phone}@owner.invalid`;
  const { data: created, error } = await admin.auth.admin.createUser({
    email, email_confirm: true, password: randomPassword(),
    app_metadata: { kind: "owner" }, user_metadata: { name: name ?? "", phone },
  });
  let id = created?.user?.id;
  if (!id) {
    // 이미 만들어진 계정(연결 표만 비어 있는 경우) 찾기
    for (let page = 1; page <= 20 && !id; page++) {
      const { data } = await admin.auth.admin.listUsers({ page, perPage: 200 });
      id = data?.users?.find((u) => u.email === email)?.id;
      if (!data?.users?.length) break;
    }
    if (!id) throw new Error("계정 생성 실패: " + (error?.message ?? "unknown"));
  }
  const { error: e2 } = await admin.from("owner_users").upsert({ user_id: id, phone, name }, { onConflict: "user_id" });
  if (e2) throw e2;
  return id;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "bad request" }, 400);
  try {
    const body = await req.json().catch(() => ({}));
    const phone = String(body.phone ?? "").replace(/[^0-9]/g, "");
    const contract = String(body.contract ?? "").replace(/[^0-9A-Za-z-]/g, "").trim();
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
    if (!/^01\d{8,9}$/.test(phone) || !contract || contract === "0" || contract.length > 20) {
      return json({ error: "전화번호와 계약번호를 확인해 주세요." }, 400);
    }
    if ((await failures("phone", phone)) >= PHONE_FAIL_MAX || (await failures("ip", ip)) >= IP_FAIL_MAX) {
      return json({ error: "여러 번 틀려서 잠시 막혔어요. 1시간 뒤에 다시 시도하거나 영업 담당자에게 문의해 주세요." }, 429);
    }
    const { data: sites, error } = await admin.from("sites").select("bm_key, owner_name")
      .eq("contract_no", contract).contains("phones", [phone]);
    if (error) throw error;
    if (!sites?.length) {
      await admin.from("owner_login_attempts").insert({ phone, ip, ok: false });
      return json({ error: "전화번호와 계약번호가 맞지 않아요. 계약서의 계약번호를 확인해 주세요." }, 401);
    }

    const name = sites[0].owner_name ?? null;
    const userId = await ownerUserId(phone, name);
    // 접속마다 새 비밀번호로 바꾸고 서버에서 바로 로그인 → 세션만 돌려줌
    const password = randomPassword();
    const { data: u, error: e3 } = await admin.auth.admin.updateUserById(userId, { password });
    if (e3 || !u?.user?.email) throw e3 ?? new Error("계정 정보를 찾지 못했어요");
    const signer = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: sess, error: e4 } = await signer.auth.signInWithPassword({ email: u.user.email, password });
    if (e4 || !sess?.session) throw e4 ?? new Error("세션 발급 실패");

    const links = sites.map((s) => ({ user_id: userId, bm_key: s.bm_key }));
    await admin.from("owner_sites").upsert(links, { onConflict: "user_id,bm_key", ignoreDuplicates: true });
    await admin.from("owner_users").update({ last_login_at: new Date().toISOString(), name }).eq("user_id", userId);
    await admin.from("owner_login_attempts").insert({ phone, ip, ok: true });

    return json({
      ok: true, name,
      sites: sites.map((s) => s.bm_key),
      access_token: sess.session.access_token,
      refresh_token: sess.session.refresh_token,
    });
  } catch (e) {
    console.error(e);
    return json({ error: "접속 중 오류가 났어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
});
