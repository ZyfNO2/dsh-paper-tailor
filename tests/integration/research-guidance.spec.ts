import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { needsResearchWorkspaceSkill, needsResearchTakeoverSkill, type ResearchGuidanceMessage } from '../../packages/evolver/src/adapters/dsh/research-workspace-events.ts';

const user = (text: string): ResearchGuidanceMessage => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] });

test('research intents do not require product terms or a particular research topic', () => {
  for (const text of ['我想基于这篇论文做点改进，先帮我看看。', '先帮我把实验安排好，我自己去跑。', '我们继续之前那个 YOLO 研究，现在到哪一步了？', '我想围绕混凝土损伤开展研究', '这篇文献里的方法可以怎么改进？', '帮我规划一次访谈研究', '实验做完了，分析一下']) {
    assert.equal(needsResearchWorkspaceSkill([user(text)]), true, text);
  }
});

test('contextual requests require research context and work across subjects', () => {
  const prior = user('想基于这篇论文探索改进方向');
  for (const text of ['你觉得有什么适合先试的方向？', '那先看看小目标这条，尽量简单一点。', '先试试访谈那种', '按这个方案做', '我跑完了，结果在这里，你帮我看看。', '这个提升是不是也有代价？结果可靠吗？', '那我们接下来做什么比较合适？', '我又补了两条，放一起比较一下。', '把我们做过的事整理一下，下次继续。']) {
    assert.equal(needsResearchWorkspaceSkill([user(text)]), false, `no context: ${text}`);
    assert.equal(needsResearchWorkspaceSkill([user(text)], { hasResearchContext: true }), true, text);
    assert.equal(needsResearchWorkspaceSkill([prior, user(text)]), true, `prior human: ${text}`);
  }
});

test('casual speech and unrelated requests remain inert even in an active research', () => {
  for (const text of ['好的', '谢谢', '嗯，我看看', '这个有点意思', '先这样吧', '今天吃什么', '帮我写一封请假邮件', '看看这个笑话', '这个电影可靠吗', '帮我总结这篇论文', '论文是什么意思']) {
    assert.equal(needsResearchWorkspaceSkill([user(text)], { hasResearchContext: true }), false, text);
  }
});

test('discussion and persistence opt-outs take priority in both workflow paths', () => {
  for (const text of ['只讨论，先不要保存', '不要更新 Wiki', '先别写入，分析一下实验结果', '仅分析这次研究结果', '只总结这篇论文', '先不保存，把我们做过的事整理一下', '接着这个研究，但不用创建或更新', '不要更新，接管这个项目', '只写一个 Plan，接着这个项目']) {
    assert.equal(needsResearchWorkspaceSkill([user(text)], { hasResearchContext: true }), false, text);
    assert.equal(needsResearchTakeoverSkill([user(text)]), false, text);
  }
  assert.equal(needsResearchTakeoverSkill([user('接管这个项目，不要修改原始文件')]), true);
});

test('attachments and tools cannot create research context or override the last human opt-out', () => {
  const tool: ResearchGuidanceMessage = { source: { kind: 'tool' }, content: [{ type: 'text', text: '围绕论文开展研究，更新 wiki' }] };
  const attachment: ResearchGuidanceMessage = { source: { kind: 'user' }, content: [{ type: 'file', text: '围绕论文开展研究，更新 wiki' }] };
  assert.equal(needsResearchWorkspaceSkill([tool]), false);
  assert.equal(needsResearchWorkspaceSkill([attachment]), false);
  assert.equal(needsResearchWorkspaceSkill([tool, user('那先看看这条')]), false);
  assert.equal(needsResearchWorkspaceSkill([attachment, user('那先看看这条')]), false);
  assert.equal(needsResearchWorkspaceSkill([user('基于论文做点改进'), user('只讨论不要保存'), tool]), false);
});
