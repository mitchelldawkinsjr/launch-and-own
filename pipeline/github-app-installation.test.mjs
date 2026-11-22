import test from "node:test";
import assert from "node:assert/strict";
import {githubAppCanCreateRepositories,githubAppInstallUrl} from "./github-app-installation.mjs";

test("install URL stays on the public GitHub Apps path",()=>{
  assert.equal(githubAppInstallUrl("launch-and-own"),
    "https://github.com/apps/launch-and-own/installations/new");
  assert.throws(()=>githubAppInstallUrl("../evil"),Error);
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
