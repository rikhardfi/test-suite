import { describe, expect, it } from 'vitest'
import type { NetworkInterfaceInfo } from 'node:os'
import { LineSplitter, cmd, meterCandidates, parseLine } from './protocol'

describe('parseLine', () => {
  it('reads a six-channel row in the documented order', () => {
    expect(parseLine('0.06,22.78,98.58,53.7,-0.17,0.066')).toEqual({
      kind: 'row',
      row: { flow: 0.06, tempC: 22.78, pressureKpa: 98.58, humidityPct: 53.7, lowPressureCmH2O: -0.17, totalL: 0.066 },
    })
  })

  it('tells acknowledgements, errors and values apart', () => {
    expect(parseLine('OK')).toEqual({ kind: 'ok' })
    expect(parseLine('ERR4')).toEqual({ kind: 'error', code: 4 })
    expect(parseLine('533002')).toEqual({ kind: 'text', text: '533002' })
  })

  it('does not take a damaged row for data', () => {
    expect(parseLine('0.06,22.78,98.58,53.7,-0.1').kind).toBe('text')
    expect(parseLine('0.06,22.78,,53.7,-0.17,0.066').kind).toBe('text')
  })
})

describe('LineSplitter', () => {
  it('keeps a line split across chunks whole', () => {
    const s = new LineSplitter()
    expect(s.push('OK\r\n0.06,22.7')).toEqual(['OK'])
    expect(s.push('8,98.58,53.7,-0.17,0.066\r\nOK')).toEqual(['0.06,22.78,98.58,53.7,-0.17,0.066'])
    expect(s.push('\r\n')).toEqual(['OK'])
  })
})

describe('commands', () => {
  it('pads the sample rate to four digits, as the meter requires', () => {
    expect(cmd.setRate(1)).toBe('SSR0001')
    expect(cmd.setRate(100)).toBe('SSR0100')
  })
})

describe('meterCandidates', () => {
  const iface = (address: string, netmask: string): NetworkInterfaceInfo =>
    ({ address, netmask, family: 'IPv4', mac: '', internal: false, cidr: null }) as NetworkInterfaceInfo

  it('offers the other two hosts of a link-local /30', () => {
    expect(meterCandidates({ en15: [iface('169.254.234.170', '255.255.255.252')] })).toEqual([
      '169.254.234.169',
    ])
    expect(meterCandidates({ en9: [iface('169.254.10.5', '255.255.255.252')] })).toEqual(['169.254.10.6'])
  })

  it('ignores ordinary networks', () => {
    expect(
      meterCandidates({
        en0: [iface('172.20.10.8', '255.255.255.240')],
        en1: [iface('169.254.1.1', '255.255.0.0')],
      }),
    ).toEqual([])
  })
})
