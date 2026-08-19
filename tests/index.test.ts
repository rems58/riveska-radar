import { describe, it, expect } from 'vitest'
import { COMMANDES } from '../src/index.ts'

describe('COMMANDES', () => {
  it('expose les quatre jobs', () => {
    expect(Object.keys(COMMANDES).sort()).toEqual(['radar', 'recheck', 'triggers', 'weekly'])
  })
})
