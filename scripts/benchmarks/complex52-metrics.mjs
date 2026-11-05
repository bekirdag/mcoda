// Delegated draft reviewed and corrected: per-arm totals, null accounting and Map keys.
export function summarizePairs(rows) {
  if (!Array.isArray(rows) || !rows.length) throw Error('Nonempty rows required');
  const names=['codali_candidate','raw_tools'], pairs=new Map();
  for (const row of rows) {
    if (!row || typeof row.id!=='string' || !row.id || !names.includes(row.arm)
      || !Number.isFinite(row.score) || row.score<0 || row.score>100) throw Error('Invalid row');
    for (const key of ['tokens','elapsedMs']) if (row[key]!==null && (!Number.isSafeInteger(row[key])||row[key]<0)) throw Error(`Invalid ${key}`);
    const pair=pairs.get(row.id)??new Map();if(pair.has(row.arm))throw Error('Duplicate task/arm');
    pair.set(row.arm,row);pairs.set(row.id,pair);
  }
  if([...pairs.values()].some(pair=>pair.size!==2))throw Error('Missing paired arm');
  const total=(list,key)=>{if(list.some(r=>r[key]===null))return null;const n=list.reduce((n,r)=>n+r[key],0);if(!Number.isSafeInteger(n))throw Error('Usage total overflow');return n;};
  const arms=Object.fromEntries(names.map(name=>{const rs=rows.filter(r=>r.arm===name);return[name,{meanScore:rs.reduce((n,r)=>n+r.score,0)/rs.length,totalTokens:total(rs,'tokens'),totalTimeMs:total(rs,'elapsedMs'),failures:rs.filter(r=>r.error).length}];}));
  const c=arms.codali_candidate,r=arms.raw_tools,ratio=(a,b)=>a===null||b===null||b===0?null:a/b;
  return {count:pairs.size,arms,scoreDifferencePoints:c.meanScore-r.meanScore,relativeScoreGain:r.meanScore===0?null:(c.meanScore-r.meanScore)/r.meanScore,tokenRatio:ratio(c.totalTokens,r.totalTokens),timeRatio:ratio(c.totalTimeMs,r.totalTimeMs)};
}
