"""Dependency-free, bounded, actual regression computation."""
import csv
import json
import sys
from pathlib import Path
from evaluate import evaluate


def run(input_path):
    spec = json.loads(Path(input_path).read_text())
    rows = list(csv.DictReader((Path(__file__).parent / 'data.csv').open()))
    train = [(float(r['x']), float(r['y'])) for r in rows if r['split'] == 'train']
    mx = sum(x for x, _ in train) / len(train)
    my = sum(y for _, y in train) / len(train)
    variant = spec['spec']['variant']
    if variant == 'baseline':
        slope, intercept = 0.0, my
    elif variant == 'candidate':
        slope = sum((x-mx)*(y-my) for x, y in train) / sum((x-mx)**2 for x, _ in train)
        intercept = my - slope*mx
    elif variant == 'ablation':
        slope = sum(x*y for x, y in train) / sum(x*x for x, _ in train)
        intercept = 0.0
    else:
        raise ValueError('Unsupported variant')
    parameters = {'slope': slope, 'intercept': intercept}
    result = {'schemaVersion': 1, 'jobId': spec['jobId'], 'token': spec['token'],
              'inputHash': spec['inputHash'], 'variant': variant, 'inputNature': 'synthetic',
              'parameters': parameters, 'metrics': evaluate(rows, parameters)}
    print(json.dumps(result, allow_nan=False))


if __name__ == '__main__':
    run(sys.argv[1])
