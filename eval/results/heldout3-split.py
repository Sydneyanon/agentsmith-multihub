import json,sys
def m(rows):
    tp=sum(r['vulnerable'] and r['reported'] for r in rows); fn=sum(r['vulnerable'] and not r['reported'] for r in rows)
    fp=sum((not r['vulnerable']) and r['reported'] for r in rows); tn=sum((not r['vulnerable']) and not r['reported'] for r in rows)
    p=f"{tp/(tp+fp):.2f}" if tp+fp else "n/a"; rc=f"{tp/(tp+fn):.2f}" if tp+fn else "n/a"
    return f"n={len(rows):2d} tp={tp:2d} fp={fp:2d} fn={fn:2d} tn={tn:2d} precision={p} recall={rc}"
out=["# Derived from the raw heldout3-run1-*.json files by eval/results/heldout3-split.py; the raw files are unedited.",""]
for name,f in [("baseline","heldout3-run1-baseline.json"),("candidate 1 (6cd3be7)","heldout3-run1-candidate1-structural.json"),("candidate 2 (9c2d80e)","heldout3-run1-candidate2-structural.json")]:
    d=json.load(open(f)); det=d['score']['detail']
    out.append(f"## {name}")
    out.append("  all labels       "+m(det))
    out.append("  clear labels     "+m([r for r in det if not r['ambiguous']]))
    out.append("  ambiguous labels "+m([r for r in det if r['ambiguous']]))
    v=d.get('validation') or []
    if v:
        from collections import Counter
        c=Counter(x['verdict'] for x in v)
        out.append(f"  execution validator on reentrancy leads: {dict(c)}; abstentions (inconclusive) = {c.get('inconclusive',0)}")
        out.append("  validator vs label: "+"; ".join(f"{x['function']}:{x['verdict']}/label-{ 'vuln' if [r for r in det if r['function']==x['function'] and r['file']==x['file'] and r['class']=='reentrancy' and r['vulnerable']] else 'benign'}" for x in v))
    out.append(f"  findings in unlabelled functions (unscored): {d['score']['unlabelledFindings']}")
    out.append("")
print("\n".join(out))
