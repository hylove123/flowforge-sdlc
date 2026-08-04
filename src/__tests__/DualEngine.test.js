import { describe, it, expect } from 'vitest'
import { reciprocalRankFusion } from '@/services/codebaseIndex'
import { graphProjectName } from '@/services/graphEngine'

describe('dual-engine — reciprocalRankFusion', () => {
  it('ranks items present in both engines above single-engine hits', () => {
    const listA = [
      { repo: 'r', file: 'a.js', name: 'shared', score: 0.9 },
      { repo: 'r', file: 'b.js', name: 'onlyA', score: 0.5 },
    ]
    const listB = [
      { repo: 'r', file: 'c.js', name: 'onlyB', score: 0 },
      { repo: 'r', file: 'a.js', name: 'shared', score: 0 },
    ]
    const fused = reciprocalRankFusion([
      { source: 'fts-vector', items: listA },
      { source: 'graph', items: listB },
    ])
    expect(fused[0].item.name).toBe('shared')
    expect(fused[0].sources).toEqual(['fts-vector', 'graph'])
    expect(fused).toHaveLength(3)
  })

  it('handles empty lists gracefully', () => {
    expect(reciprocalRankFusion([
      { source: 'fts-vector', items: [] },
      { source: 'graph', items: [] },
    ])).toEqual([])
  })
})

describe('dual-engine — graphProjectName', () => {
  it('derives the project name from the repo directory basename', () => {
    expect(graphProjectName({ path: '/data/repos/order-service' })).toBe('order-service')
  })

  it('strips trailing separators', () => {
    expect(graphProjectName({ path: '/data/repos/order-service/' })).toBe('order-service')
  })

  it('falls back to repo name when path is missing', () => {
    expect(graphProjectName({ path: '', name: 'fallback' })).toBe('fallback')
  })
})
