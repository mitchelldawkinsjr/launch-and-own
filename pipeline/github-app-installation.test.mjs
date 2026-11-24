import test from "node:test";
import assert from "node:assert/strict";
import {
  CLOUDFLARE_WORKERS_PAGES_APP_SLUG,
  githubAppCanCreateRepositories,
  githubAppInstallUrl,
  githubAppInstalledOnUser,
  listUserGithubAppInstallations
} from "./github-app-installation.mjs";

test("install URL stays on the public GitHub Apps path",()=>{
  assert.equal(githubAppInstallUrl("launch-and-own"),
    "https://github.com/apps/launch-and-own/installations/new");
  assert.equal(githubAppInstallUrl(CLOUDFLARE_WORKERS_PAGES_APP_SLUG),
    "https://github.com/apps/cloudflare-workers-and-pages/installations/new");
  assert.throws(()=>githubAppInstallUrl("../evil"),Error);
});

test("lists installations once for Launch & Own and Workers & Pages checks",async()=>{
  let calls=0;
  const installations=await listUserGithubAppInstallations({
    accessToken:"ghu_test",
    fetchFn:async(url)=>{
      calls+=1;
      assert.equal(url,"https://api.github.com/user/installations?per_page=100");
      return Response.json({installations:[{
        app_slug:"launch-and-own",
        account:{login:"tester",type:"User"},
        permissions:{repository_creation:"write",contents:"write"}
      },{
        app_slug:CLOUDFLARE_WORKERS_PAGES_APP_SLUG,
        account:{login:"tester",type:"User"},
        permissions:{administration:"write",contents:"write"}
      }]});
    }
  });
  assert.equal(calls,1);
  assert.equal(await githubAppCanCreateRepositories({
    accessToken:"ghu_test",appSlug:"launch-and-own",githubLogin:"tester",installations
  }),true);
  assert.equal(githubAppInstalledOnUser({
    installations,appSlug:CLOUDFLARE_WORKERS_PAGES_APP_SLUG,githubLogin:"tester"
  }),true);
});

test("requires an installation on the personal account with repository creation",async()=>{
  const ok=await githubAppCanCreateRepositories({
    accessToken:"ghu_test",
    appSlug:"launch-and-own",
    githubLogin:"tester",
    fetchFn:async(url)=>{
      assert.equal(url,"https://api.github.com/user/installations?per_page=100");
      return Response.json({installations:[{
        app_slug:"launch-and-own",
        account:{login:"tester",type:"User"},
        permissions:{repository_creation:"write",contents:"write"}
      }]});
    }
  });
  assert.equal(ok,true);
});

test("rejects OAuth-only sessions without an installation",async()=>{
  const ok=await githubAppCanCreateRepositories({
    accessToken:"ghu_test",
    appSlug:"launch-and-own",
    githubLogin:"tester",
    fetchFn:async()=>Response.json({installations:[]})
  });
  assert.equal(ok,false);
});

test("rejects installations that lack repository creation",async()=>{
  const ok=await githubAppCanCreateRepositories({
    accessToken:"ghu_test",
    appSlug:"launch-and-own",
    githubLogin:"tester",
    fetchFn:async()=>Response.json({installations:[{
      app_slug:"launch-and-own",
      account:{login:"tester",type:"User"},
      permissions:{contents:"write",metadata:"read"}
    }]})
  });
  assert.equal(ok,false);
});

test("Workers & Pages only needs to be installed on the personal account",()=>{
  assert.equal(githubAppInstalledOnUser({
    installations:[{
      app_slug:CLOUDFLARE_WORKERS_PAGES_APP_SLUG,
      account:{login:"tester",type:"User"},
      permissions:{contents:"write"}
    }],
    appSlug:CLOUDFLARE_WORKERS_PAGES_APP_SLUG,
    githubLogin:"tester"
  }),true);
  assert.equal(githubAppInstalledOnUser({
    installations:[{
      app_slug:CLOUDFLARE_WORKERS_PAGES_APP_SLUG,
      account:{login:"other",type:"User"},
      permissions:{contents:"write"}
    }],
    appSlug:CLOUDFLARE_WORKERS_PAGES_APP_SLUG,
    githubLogin:"tester"
  }),false);
});
