# Portable regression execution profile

This is a synthetic engineering acceptance fixture, not a paper reproduction or a scientific finding. The committed CSV contains 64 samples from `y = 2.5*x + 1.25 + uniform(-.15,.15)`, Python `random.Random(20261022)`. Every fourth sample is the frozen test split. No downloads, PyTorch or credentials are needed.

Variants: baseline predicts the training mean; candidate fits slope and intercept by least squares; ablation omits the intercept. The independent evaluator reports test mean squared error in `squared_y`. The data, runner and evaluator hashes are captured per run. Changing any file creates a different input identity.

Run the supported profile through `scripts/research-foundations.mjs demo --workspace <directory>`. It creates an explicitly labelled synthetic research and runs three real CPU jobs. Production untrusted code should use the Docker backend; this local backend only executes these repository-owned scripts.

Original fixture code and generated dataset: MIT, same license as this repository.
