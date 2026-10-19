"""
Training-hook fixtures for the Phase 2 mechanism probe.

Spec row: docs/mvp/phases/PHASE2-SPEC.md section 4, "training_hook/数据策略".

A hook object exists in the code either way. The probe registers it for real and counts how often
it actually fires on the training path, so "静态代码存在但训练未走该分支" becomes a measured
fireCount of 0 instead of an inference from the source text.
"""


class PositionRecordingHook:
    """Records where and when it was called. It never decides whether that is correct."""

    def __init__(self, hook_id, registered_position):
        self.hook_id = hook_id
        self.registered_position = registered_position
        self.fire_count = 0
        self.observed_positions = []
        self.observed_steps = []

    def fire(self, position, step):
        self.fire_count += 1
        self.observed_positions.append(position)
        self.observed_steps.append(int(step))

    def as_forward_hook(self):
        def _hook(_module, _inputs, _output):
            self.fire('forward_hook', -1)
        return _hook
