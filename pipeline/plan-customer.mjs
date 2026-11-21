// Reusable, deterministic provisioning plan. No account changes or secret handling.
// Usage: node pipeline/plan-customer.mjs customer.json
export function slugify(value) {
  return String(value).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,40).replace(/-$/,"");
}
export function planCustomer(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Customer configuration must be an object");
  const {name,accountId,githubOwner,forms=false,ownerEmail,hostname}=input;
  if(typeof name!=="string" || !name.trim())throw Error("Customer name is required");
  if(typeof accountId!=="string" || !/^[a-f0-9]{32}$/i.test(accountId))throw Error("Valid Cloudflare account ID is required");
  if(typeof githubOwner!=="string" || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(githubOwner))throw Error("Valid GitHub owner is required");
  if(typeof forms!=="boolean")throw Error("forms must be a boolean");
  if(forms && (typeof ownerEmail!=="string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)))throw Error("Valid ownerEmail required for forms");
  if(hostname!==undefined && (typeof hostname!=="string" || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(hostname) || !hostname.includes(".")))throw Error("Invalid hostname");
  const slug=slugify(name);
  if(!slug)throw Error("Customer name must contain letters or numbers");
  const prefix="esp-"+slug;
  const pages=prefix+"-site";
  const domain=hostname||pages+".pages.dev";
  const steps=[
    {id:"github",resource:"github-repository",name:prefix,requires:[]},
    {id:"pages",resource:"cloudflare-pages",name:pages,requires:["github"]},
    {id:"deploy",resource:"pages-deployment",name:domain,requires:["pages"]}
  ];
  if(forms)steps.push(
    {id:"d1",resource:"cloudflare-d1",name:prefix+"-forms",requires:[]},
    {id:"turnstile",resource:"cloudflare-turnstile",name:prefix+"-contact",requires:[]},
    {id:"worker",resource:"cloudflare-worker",name:prefix+"-forms",requires:["d1","turnstile"]},
    {id:"access",resource:"cloudflare-access",name:prefix+"-admin",requires:["worker"]},
    {id:"form-deploy",resource:"form-enabled-pages-deployment",name:domain,requires:["worker","access","deploy"]},
    {id:"acceptance",resource:"human-verified-form-and-dashboard-test",name:domain,requires:["form-deploy"]}
  );
  return {version:1,mode:"plan-only",customer:slug,accountId,githubOwner,domain,forms,steps,
    safeguards:["Require explicit account authorization before each provider mutation","Never print, store, or commit Turnstile or API secrets","Discover existing resources before create; fail on ownership/name collisions","Do not report success until deployment and live acceptance pass","No email provider or billing required by default"]};
}
if(process.argv[1] && import.meta.url===new URL("file://"+process.argv[1]).href){
  const {readFileSync}=await import("node:fs");
  if(!process.argv[2])throw Error("Usage: node pipeline/plan-customer.mjs customer.json");
  console.log(JSON.stringify(planCustomer(JSON.parse(readFileSync(process.argv[2],"utf8"))),null,2));
}
