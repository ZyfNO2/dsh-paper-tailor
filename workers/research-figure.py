"""Rebuild a figure from the colocated CSV; no model or network calls."""
import csv
import json
import platform
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
from matplotlib import pyplot as plt

root = Path(__file__).resolve().parent
rows = list(csv.DictReader((root/'data.csv').open()))
fig, ax = plt.subplots(figsize=(5, 3))
ax.bar([r['variant'] for r in rows], [float(r['mse']) for r in rows], color='#386b85')
ax.set_ylabel('Test MSE (squared_y)')
ax.set_title('Synthetic regression execution fixture')
fig.tight_layout()
for fmt in ['svg', 'png', 'pdf']:
    fig.savefig(root/('figure.'+fmt), dpi=180, metadata={'Creator': 'DSH Paper Tailor'})
(root/'environment.json').write_text(json.dumps({'python': platform.python_version(), 'matplotlib': matplotlib.__version__}))
