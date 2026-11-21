// Bounded, secret-free launch receipts survive removal of one-hour OAuth sessions.
// Reads require a reconnected GitHub identity AND selected/verified Cloudflare account.
export const RECEIPT_TTL_SECONDS=30*24*60*60;
const idPattern=/^[0-9a-f-]{36}$/i;
export async function syncApprovedReceipt(env,{id,sessionHash}){
  if(typeof id!=="string"||!idPattern.test(id)||typeof sessionHash!=="string"||!/^[a-f0-9]{64}$/i.test(sessionHash))
    throw Error("Cannot identify an approved launch");
  const result=await env.DB.prepare(`INSERT INTO onboarding_launch_receipts
      (id,github_user_id,github_login,cloudflare_account_id,customer_name,plan_json,
       status,approved_at,updated_at,expires_at)
    SELECT l.id,s.github_user_id,l.github_login,l.cloudflare_account_id,l.customer_name,
           l.plan_json,l.status,l.approved_at,l.updated_at,l.approved_at+?
    FROM onboarding_launches l JOIN onboarding_sessions s ON l.session_hash=s.id_hash
    WHERE l.id=? AND l.session_hash=? AND l.approved_at IS NOT NULL
    ON CONFLICT(id) DO UPDATE SET
      status=excluded.status,updated_at=excluded.updated_at
    WHERE onboarding_launch_receipts.github_user_id=excluded.github_user_id
      AND onboarding_launch_receipts.cloudflare_account_id=excluded.cloudflare_account_id
      AND excluded.updated_at>=onboarding_launch_receipts.updated_at`)
    .bind(RECEIPT_TTL_SECONDS,id,sessionHash).run();
  return result;
}
export async function listOwnedReceipts(env,{githubUserId,cloudflareAccountId,time}){
  if(!Number.isSafeInteger(githubUserId)||githubUserId<1||
     typeof cloudflareAccountId!=="string"||!/^[a-f0-9]{32}$/i.test(cloudflareAccountId))
    throw Error("Reconnect GitHub and select an authorized Cloudflare account");
  const results=await env.DB.prepare(`SELECT id,customer_name,status,plan_json,approved_at,updated_at
    FROM onboarding_launch_receipts WHERE github_user_id=? AND cloudflare_account_id=?
      AND expires_at>? ORDER BY updated_at DESC LIMIT 20`)
    .bind(githubUserId,cloudflareAccountId,time).all();
  return results.results||[];
}
export async function getOwnedReceipt(env,{id,githubUserId,cloudflareAccountId,time}){
  if(typeof id!=="string"||!idPattern.test(id)||!Number.isSafeInteger(githubUserId)||
    typeof cloudflareAccountId!=="string"||!/^[a-f0-9]{32}$/i.test(cloudflareAccountId))return null;
  return await env.DB.prepare(`SELECT id,github_user_id,github_login,customer_name,
    cloudflare_account_id,plan_json,status,approved_at,updated_at
    FROM onboarding_launch_receipts
    WHERE id=? AND github_user_id=? AND cloudflare_account_id=? AND expires_at>?`)
    .bind(id,githubUserId,cloudflareAccountId,time).first();
}
export async function purgeExpiredReceipts(env,time){
  await env.DB.prepare("DELETE FROM onboarding_launch_receipts WHERE expires_at<=?").bind(time).run();
}
