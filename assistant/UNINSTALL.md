# Uninstall the customer-owned assistant (T-CLN)

Removes only the assistant resources. Your website repository, Pages site, and pull-request history stay untouched.

Do this from an account that owns the assistant Worker and the private GitHub App.

1. **Export approval history (optional).**  
   `npx wrangler d1 export lo-assistant-<siteSlug> --remote --output=assistant-history.sql`

2. **Delete the GitHub App.**  
   GitHub → Settings → Developer settings → GitHub Apps → `<siteSlug>-assistant` → Delete.  
   Deleting the App also removes its installation on the website repo.

3. **Delete Cloudflare Access.**  
   Zero Trust → Access → Applications → delete `Launch & Own Assistant (<siteSlug>)`.  
   Remove any related Access policy that only existed for the assistant.

4. **Delete the Worker.**  
   `npx wrangler delete lo-assistant-<siteSlug> --force`  
   If you later created a preview Worker: `npx wrangler delete lo-assistant-<siteSlug>-preview --force`

5. **Delete D1.**  
   `npx wrangler d1 delete lo-assistant-<siteSlug> --skip-confirmation`

6. **Delete the private assistant repository (optional).**  
   GitHub → `<owner>/<siteSlug>-assistant` → Settings → Delete this repository.  
   Website repo branches named `launch-and-own/edit-*` can stay or be deleted; they are not required for the site.

7. **Confirm.**  
   - `/healthz` on the old assistant hostname returns nothing useful (Worker gone).  
   - No App named `<siteSlug>-assistant` remains.  
   - Website Pages / production deploy still works.

Launch & Own never held your credentials, so there is nothing to revoke on the Launch & Own side.
