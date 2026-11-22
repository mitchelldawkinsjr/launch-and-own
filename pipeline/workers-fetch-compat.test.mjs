import test from "node:test";
import assert from "node:assert/strict";
import {readdirSync,readFileSync} from "node:fs";

// GitHub's REST API returns 403 without a User-Agent. Node's fetch adds one, Workers' fetch does not,
// so mocked tests cannot catch a missing header: check every source file that calls api.github.com.
test("every api.github.com caller sends a User-Agent header",()=>{
  const checked=[];
  for(const dir of ["pipeline","onboarding","site","scripts"]){
    for(const name of readdirSync(new URL("../"+dir,import.meta.url))){
      if(!name.endsWith(".mjs")||name.includes("test"))continue;
      const source=readFileSync(new URL(`../${dir}/${name}`,import.meta.url),"utf8");
      if(!source.includes("https://api.github.com"))continue;
      checked.push(name);
      assert.match(source,/["']user-agent["']\s*:\s*["']launch-and-own["']/i,`${dir}/${name} calls GitHub without a User-Agent`);
    }
  }
  assert.ok(checked.length>=5,"expected the known GitHub API callers to be checked");
});

// Workers' fetch throws on redirect:"error" (only "follow" or "manual"); Node accepts it, so mocks hide it.
// validate-config.mjs and scripts/ run only under Node and may keep it.
test("Worker-executed code never uses fetch redirect \"error\"",()=>{
  for(const dir of ["pipeline","onboarding","site"]){
    for(const name of readdirSync(new URL("../"+dir,import.meta.url))){
      if(!name.endsWith(".mjs")||name.includes("test")||name==="validate-config.mjs")continue;
      const source=readFileSync(new URL(`../${dir}/${name}`,import.meta.url),"utf8");
      assert.doesNotMatch(source,/redirect:\s*["']error["']/,`${dir}/${name} uses redirect:"error", which Workers reject`);
      // Also catch defaults like `redirect: options.redirect ?? 'error'` that the line-start pattern misses.
      assert.doesNotMatch(source,/\?\?\s*["']error["']/,`${dir}/${name} defaults a fetch redirect to "error"`);
    }
  }
});
