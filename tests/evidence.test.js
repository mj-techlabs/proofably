import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateExperiment} from '../src/evidence.js';
const ok=(stdout)=>({exitCode:0,stdout,stderr:'',timedOut:false});
test('same output is not a difference',()=>assert.equal(evaluateExperiment({id:'a',command:['node']},ok('a'),ok('a')).status,'no-difference'));
test('different output is not automatically a defect',()=>assert.equal(evaluateExperiment({id:'a',command:['node']},ok('a'),ok('b')).status,'behavioral-difference'));
test('timeouts are unverified',()=>assert.equal(evaluateExperiment({id:'a',command:['node']},{...ok('a'),timedOut:true},ok('b')).status,'unverified'));
