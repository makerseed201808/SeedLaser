"""B6 3D 放板 → 二维自动开槽：隔板（下边是没配对的 A 边）在 3D 里立到底板上表面，点「按摆放开插槽」→ 确认，
底板草图里多一排插槽孔、和 A 边配成一对；隔板吸到准确位置，这对连接 3D ✓、无穿透；回二维画板连接清单是「插槽（T 型）」✓。
平放（没立起来）时找不到、不改任何东西。带断言。"""
import asyncio
from _kit import run, ED

D = 'window.__seedDebug'
SQ = lambda x, y, w, h: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]

# 把隔板 P 大致立到底板 Q 的上表面（差约 1 mm，像手摆的）：A 边（P 局部中面 z = t/2）落在 Q 局部 z = t、x 居中、y 在中线；齿朝 Q 里面（-z）
STAND = f"""(()=>{{const d={D}, T=d.THREE, W=d.W, t=W.model.thickness;
  const ids=W.model.parts.map(p=>p.id); const P=ids.find(id=>d.jointsOf(id).length), Q=ids.find(id=>id!==P);
  const j=d.jointsOf(P)[0]; const a=new T.Vector3(j.a[0],j.a[1],0), b=new T.Vector3(j.b[0],j.b[1],0), c=new T.Vector3(j.c[0],j.c[1],0);
  const u=b.clone().sub(a).normalize(); let n=c.clone().sub(a); n.sub(u.clone().multiplyScalar(n.dot(u))).normalize(); const ez=new T.Vector3(0,0,1);
  const src=new T.Matrix4().makeBasis(u,n,ez);
  let Y=new T.Vector3(0,1,0); if (Math.sign(new T.Matrix4().makeBasis(new T.Vector3(1,0,0),new T.Vector3(0,0,-1),Y).determinant())!==Math.sign(src.determinant())) Y=new T.Vector3(0,-1,0);
  const R=new T.Matrix4().makeBasis(new T.Vector3(1,0,0),new T.Vector3(0,0,-1),Y).multiply(src.clone().invert());
  const q=d.partById(Q); const L=a.distanceTo(b);
  const target=new T.Vector3(q.w/2-L/2+0.7, q.h/2+0.4, t+1.0);         // a 点（中面）要去的位置（Q 局部）：故意差约 1 mm，模拟手摆的误差
  const am=a.clone().setZ(t/2).applyMatrix4(R);
  const local=new T.Matrix4().makeTranslation(target.x-am.x, target.y-am.y, target.z-am.z).multiply(R);
  const MQ=new T.Matrix4().fromArray(W.project.poses&&W.project.poses[Q]||q.matrix);
  W.project.poses=W.project.poses||{{}}; W.project.poses[Q]=MQ.toArray(); W.project.poses[P]=MQ.clone().multiply(local).toArray();
  return {{P,Q}};}})()"""


async def body(k, case):
    pg = k.pg
    await k.add('cut', SQ(20, 20, 160, 100))      # 底板
    await k.add('cut', SQ(220, 160, 100, 60))     # 隔板
    await k.tool('joint'); await k.click(270, 160); await pg.keyboard.press('Escape')
    await k.tool('select'); await pg.wait_for_timeout(1500)
    await pg.click('.sk-back'); await pg.wait_for_timeout(3500)

    async def flat():
        n = await k.ev(f"{D}.teeCandidates().length")
        assert n == 0, ('平放时不应找到', n)
        await pg.click('#parts-panel [data-k=tee]'); await pg.wait_for_timeout(300)
        assert not await pg.query_selector('.tee-ask'), '没找到时不弹确认框'
    await case('平放（没立起来）：找不到、不弹确认框、不改东西', flat())

    async def stand():
        ids = await k.ev(STAND)
        assert await k.ev(f"{D}.teeCandidates().length") == 1
        await pg.click('#parts-panel [data-k=tee]'); await pg.wait_for_selector('.tee-ask')
        txt = await pg.inner_text('.tee-ask')
        assert '插进' in txt, txt
        await pg.click('.tee-ask [data-r=yes]'); await pg.wait_for_timeout(6000)
        sk = await k.ev(f"(()=>{{const W={D}.W; const m=[]; (W.project.sketches['{ids['Q']}'].items||[]).forEach(it=>(it.joints||[]).forEach(j=>m.push(j))); return m.map(j=>[j.type,j.pair,j.k]);}})()")
        a = await k.ev(f"{D}.jointsOf('{ids['P']}').map(j=>[j.type,j.pair])")
        assert len(sk) == 1 and sk[0][0] == 'mortise' and sk[0][2] >= 1, sk
        assert a[0][1] and a[0][1] == sk[0][1], ('插槽和 A 边要配成一对', a, sk)
        cs3 = await k.ev(f"{D}.connState")
        assert list(v['state'] for v in cs3.values()) == ['ok'], cs3
        rep = await k.ev(f"{D}.W.pose.report")
        assert rep and not any(v['collide'] for v in rep.values()), rep
    await case('立在底板上 → 确认 → 底板开插槽并和 A 边配对；隔板吸到准确位置，3D ✓、无穿透', stand())

    async def undo():
        await pg.click('#parts-panel [data-k=teeundo]'); await pg.wait_for_timeout(5000)
        n = await k.ev(f"(()=>{{let m=0; Object.values({D}.W.project.sketches).forEach(sk=>sk.items.forEach(it=>(it.joints||[]).forEach(j=>{{ if (j.type==='mortise') m++; }}))); return m;}})()")
        assert n == 0, ('撤销后插槽应该没了', n)
        assert all(not j.get('pair') for j in await k.ev(f"(()=>{{const o=[]; Object.values({D}.W.project.sketches).forEach(sk=>sk.items.forEach(it=>(it.joints||[]).forEach(j=>o.push(j)))); return o;}})()")), '撤销后 A 边不再配对'
        assert not await pg.query_selector('#parts-panel [data-k=teeundo]'), '撤销一次后按钮消失'
        # 再开一次，供后面回画板检查
        await k.ev(STAND)
        await pg.click('#parts-panel [data-k=tee]'); await pg.wait_for_selector('.tee-ask')
        await pg.click('.tee-ask [data-r=yes]'); await pg.wait_for_timeout(6000)
    await case('「↩ 撤销开槽」一步撤回：插槽和配对都没了，按钮消失', undo())

    async def back():
        await pg.click('#stage-bar [data-stage=design]'); await pg.wait_for_timeout(2500)
        c = await k.ev(f"(()=>{{const c={ED}.connections(); return c.pairs.map(p=>[p.tee,p.ok]);}})()")
        assert c == [[True, True]], c
    await case('回二维画板：连接清单是「插槽（T 型）」✓', back())


asyncio.run(run(body, 'conn6')) and print('PASS conn6：3D 里立好隔板 → 按摆放开插槽 → 底板开孔并配对、吸到准确位置、3D ✓ 无穿透、二维清单 ✓；平放时不误开')
