"""Render the README chart from the original comparison data. Requires matplotlib."""
import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

root = Path(__file__).resolve().parents[1]
results = json.loads((root/'benchmarks/results.json').read_text())
base = results['search']['off']['rounds'][0]['metrics']
jev = results['search']['on']['rounds'][0]['metrics']
plt.rcParams.update({'font.family':'DejaVu Sans','font.size':12,'text.color':'#18383b',
                     'axes.labelcolor':'#18383b','xtick.color':'#516367','ytick.color':'#18383b'})
fig, axes = plt.subplots(1,2,figsize=(12,4.5),dpi=160)
fig.patch.set_facecolor('#f5f1e7')
fig.suptitle('Chartroom · Jev off / on',x=.075,y=.94,ha='left',fontsize=23,fontweight='bold')
fig.text(.075,.835,'Same 30 synthetic notes. Same 20 questions. No embeddings.',fontsize=12,color='#516367')
for ax, field, title in zip(axes,['top1','top3'],['Correct first result','Correct result in the first three']):
    ax.set_facecolor('#f5f1e7')
    values=[base[field],jev[field]]
    ax.barh([1,0],values,height=.45,color=['#8e9c9a','#236c67'])
    ax.set_yticks([1,0],['Jev off','Jev on'])
    ax.set_xlim(0,22);ax.set_xticks([0,5,10,15,20]);ax.set_ylim(-.6,1.6)
    ax.set_title(title,loc='left',pad=14,fontsize=14,fontweight='bold')
    ax.set_xlabel('Questions answered by the retrieved page',fontsize=10)
    ax.spines[['top','right','left','bottom']].set_visible(False)
    ax.tick_params(axis='both',length=0,pad=8)
    ax.grid(axis='x',color='#d5d9d2',linewidth=.7);ax.set_axisbelow(True)
    for y,value in zip([1,0],values):ax.text(value+.3,y,f'{value}/20',va='center',fontsize=13,fontweight='bold')
fig.text(.075,.065,'Synthetic demonstration · GBrain 0.48.2.0 · September 19, 2026',fontsize=10,color='#516367')
fig.text(.075,.025,'Retrieval accuracy only; no generated answers. Full methods and limitations: benchmarks/RESULTS.md',fontsize=9,color='#516367')
fig.subplots_adjust(left=.075,right=.95,top=.67,bottom=.25,wspace=.36)
fig.savefig(root/'assets/comparison.png',facecolor=fig.get_facecolor())
