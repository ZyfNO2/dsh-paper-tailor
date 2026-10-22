"""Optional ranking adapter. It cannot decide inclusion or exclude a report."""
import json
import sys
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.naive_bayes import MultinomialNB
from asreview.learner import ActiveLearningCycle


class ProbabilityOrder:
    def query(self, scores):
        return np.argsort(-np.asarray(scores), kind='stable')


data = json.load(sys.stdin)
rows = data['records']
if len(rows) > 10000 or len({r['reportId'] for r in rows}) != len(rows):
    raise ValueError('Bounded, unique reports required')
known = [i for i, r in enumerate(rows) if r['label'] in [0, 1]]
if {rows[i]['label'] for i in known} != {0, 1}:
    raise ValueError('At least one human-labelled include and exclude required')
X = TfidfVectorizer(max_features=10000).fit_transform([r['title'] for r in rows])
cycle = ActiveLearningCycle(querier=ProbabilityOrder(), classifier=MultinomialNB())
cycle.fit(X[known], np.array([rows[i]['label'] for i in known]))
pending = [i for i, r in enumerate(rows) if r['label'] is None]
ranking = cycle.rank(X[pending]).tolist() if pending else []
print(json.dumps({'rankedReportIds': [rows[pending[i]]['reportId'] for i in ranking],
                  'boundary': 'Ranking only. Human eligibility decisions and stopping policy remain in DSH.'}))
