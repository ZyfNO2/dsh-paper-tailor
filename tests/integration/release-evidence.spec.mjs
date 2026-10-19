import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvidence } from '../../scripts/release/evidence-binding.mjs';
const value = () => ({ releaseDigest:'current',result:'pass',checks:[{id:'host/boot',status:'pass'}] });
test('rejects stale evidence for another release',()=>assert.throws(()=>validateEvidence(value(),'new',['host/boot']),/does not match/));
test('rejects a missing or duplicate required check',()=>{assert.throws(()=>validateEvidence(value(),'current',['host/auth']),/Missing/);const v=value();v.checks.push(v.checks[0]);assert.throws(()=>validateEvidence(v,'current',['host/boot']),/Duplicate/);});
test('cannot convert not_run or a failed result into a pass',()=>{const v=value();v.checks[0].status='not_run';assert.throws(()=>validateEvidence(v,'current',['host/boot']),/incomplete/);});
test('accepts matching explicit checks',()=>assert.equal(validateEvidence(value(),'current',['host/boot']).length,1));
