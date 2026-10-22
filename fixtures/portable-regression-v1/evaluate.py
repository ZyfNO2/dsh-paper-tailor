"""Frozen test evaluator. Candidate fitting receives training rows only."""
import math


def evaluate(rows, parameters):
    errors = [(float(r['y']) - (parameters['slope'] * float(r['x']) + parameters['intercept'])) ** 2
              for r in rows if r['split'] == 'test']
    if not errors or any(not math.isfinite(e) for e in errors):
        raise ValueError('Missing test data or nonfinite prediction')
    return {'mse': sum(errors) / len(errors), 'test_n': len(errors)}
