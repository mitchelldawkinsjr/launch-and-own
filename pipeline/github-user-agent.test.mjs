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
