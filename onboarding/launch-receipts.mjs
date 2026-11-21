// Bounded, secret-free launch receipts survive removal of one-hour OAuth sessions.
// Reads require a reconnected GitHub identity AND selected/verified Cloudflare account.
export const RECEIPT_TTL_SECONDS=30*24*60*60;
const idPattern=/^[0-9a-f-]{36}$/i;
export async function listOwnedReceipts(env,{githubUserId,cloudflareAccountId,time}){
  if(!Number.isSafeInteger(githubUserId)||githubUserId<1||
     typeof cloudflareAccountId!=="string"||!/^[a-f0-9]{32}$/i.test(cloudflareAccountId))
    throw Error("Reconnect GitHub and select an authorized Cloudflare account");
  const results=await env.DB.prepare(`SELECT r.id,r.customer_name,r.status,r.plan_json,r.updated_at
    FROM onboarding_launch_receipts r WHERE r.github_user_id=? AND r.cloudflare_account_id=?
      AND r.expires_at>? AND NOT EXISTS (SELECT 1 FROM onboarding_launch_jobs j WHERE j.legacy_receipt_id=r.id)
      ORDER BY r.updated_at DESC LIMIT 20`)
    .bind(githubUserId,cloudflareAccountId,time).all();
  return results.results||[];
}
export async function getOwnedReceipt(env,{id,githubUserId,cloudflareAccountId,time}){
  if(typeof id!=="string"||!idPattern.test(id)||!Number.isSafeInteger(githubUserId)||
    typeof cloudflareAccountId!=="string"||!/^[a-f0-9]{32}$/i.test(cloudflareAccountId))return null;
  return await env.DB.prepare(`SELECT id,github_user_id,github_login,customer_name,
    cloudflare_account_id,plan_json,status,approved_at,expires_at
    FROM onboarding_launch_receipts r
    WHERE id=? AND github_user_id=? AND cloudflare_account_id=? AND expires_at>?
      AND NOT EXISTS (SELECT 1 FROM onboarding_launch_jobs j WHERE j.legacy_receipt_id=r.id)`)
    .bind(id,githubUserId,cloudflareAccountId,time).first();
}
export async function purgeExpiredReceipts(env,time){
  await env.DB.prepare("DELETE FROM onboarding_launch_receipts WHERE expires_at<=?").bind(time).run();
}
