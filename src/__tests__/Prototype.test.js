import { describe, it, expect, vi } from 'vitest'

// ai.js pulls in the whole LLM stack — mock the only function prototype.js uses
vi.mock('@/services/ai', () => ({
  generateDeliverable: vi.fn(),
}))

import { extractHtml, generatePrototype } from '@/services/prototype'
import { generateDeliverable } from '@/services/ai'

describe('prototype — extractHtml', () => {
  it('strips html code fences', () => {
    const raw = '好的，这是原型：\n```html\n<!DOCTYPE html><html></html>\n```\n请查收'
    expect(extractHtml(raw)).toBe('<!DOCTYPE html><html></html>')
  })

  it('keeps bare HTML untouched', () => {
    expect(extractHtml('<html><body>x</body></html>')).toBe('<html><body>x</body></html>')
  })

  it('returns empty string for empty input', () => {
    expect(extractHtml('')).toBe('')
    expect(extractHtml(null)).toBe('')
  })
})

describe('prototype — generatePrototype', () => {
  it('passes PRD content as previousContent with the prototype prompt key', async () => {
    generateDeliverable.mockResolvedValue('<!DOCTYPE html><html><body>ok</body></html>')
    const html = await generatePrototype('# PRD 内容', '项目A', '需求描述')
    expect(generateDeliverable).toHaveBeenCalledWith('prototype', '项目A', '需求描述', '# PRD 内容', null)
    expect(html).toContain('<html>')
  })

  it('rejects when the model returns non-HTML content', async () => {
    generateDeliverable.mockResolvedValue('抱歉，我无法生成原型。')
    await expect(generatePrototype('prd', '项目A', '需求')).rejects.toThrow('有效的 HTML')
  })
})
