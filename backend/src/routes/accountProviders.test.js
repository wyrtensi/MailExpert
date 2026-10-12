import {beforeEach,expect,it,vi} from 'vitest';
vi.mock('../services/redis.js',()=>({redisClient:{incr:async()=>{throw new Error('offline');},del:async()=>{}}}));
import {withCreationAdmission} from '../services/accounts/accountCreation.js';
import {reset} from '../services/rateLimiter.js';
beforeEach(async()=>{for(let i=0;i<5;i++)await reset(`account-create:user-${i}`);});
it('caps concurrent work at two per employee and releases admission after cleanup',async()=>{
 let release;
 const wait=new Promise(resolve=>{release=resolve;});
 const actor={userId:'user-0'};
 const a=withCreationAdmission(actor,()=>wait),b=withCreationAdmission(actor,()=>wait);
 await new Promise(resolve=>setTimeout(resolve,0));
 expect(await withCreationAdmission(actor,()=>({accepted:true}))).toEqual({error:'rate_limited',code:'rate_limited'});
 release({accepted:true});await Promise.all([a,b]);
 expect(await withCreationAdmission(actor,()=>({accepted:true}))).toEqual({accepted:true});
});
it('caps concurrent work at eight across employees and releases failed work',async()=>{
 let release;
 const wait=new Promise(resolve=>{release=resolve;});
 const pending=[];
 for(let i=0;i<4;i++)for(let j=0;j<2;j++)pending.push(withCreationAdmission({userId:`user-${i}`},()=>wait));
 await new Promise(resolve=>setTimeout(resolve,0));
 expect(await withCreationAdmission({userId:'user-4'},()=>({accepted:true}))).toMatchObject({error:'rate_limited'});
 release();await Promise.all(pending);
 await expect(withCreationAdmission({userId:'user-4'},()=>{throw new Error('failed');})).rejects.toThrow('failed');
 expect(await withCreationAdmission({userId:'user-4'},()=>({accepted:true}))).toEqual({accepted:true});
});
