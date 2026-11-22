import test from "node:test";
import assert from "node:assert/strict";
import {runBetaRehearsal} from "./beta-rehearsal.mjs";

test("one-page beta dry run checks initial and changed preview over loopback",async()=>{
  const evidence=await runBetaRehearsal();
  assert.equal(evidence.mode,"offline-localhost-only");
  assert.equal(evidence.providerRequests,0);
  assert.equal(evidence.published,false);
  assert.equal(evidence.customerApprovalCollected,false);
  assert.equal(evidence.changedRevision,true);
  assert.notEqual(evidence.firstPreview.sha256,evidence.proposedEdit.sha256);
  for(const result of [evidence.firstPreview,evidence.proposedEdit]){
    assert.equal(result.pageCount,1);
    assert.equal(result.localhostVerified,true);
    assert.equal(result.matchesUpdatePreview,true);
    assert.match(result.sha256,/^[a-f0-9]{64}$/);
  }
});
