import { mkdir, writeFile } from 'node:fs/promises'
import { getDocumentProxy } from 'unpdf'

const ENDPOINT = 'https://www.cmegroup.com/daily_bulletin/current/Section64_Metals_Option_Products.pdf'
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const FUTURES_MONTH_CODES = ['F', 'G', 'H', 'J', 'K', 'M', 'N', 'Q', 'U', 'V', 'X', 'Z']

async function extractPageItems(pdf, pageNumber) {
  const page = await pdf.getPage(pageNumber)
  const content = await page.getTextContent()
  return content.items.flatMap((item) => {
    if (!('str' in item) || !Array.isArray(item.transform)) return []
    return [{ str: item.str, x: item.transform[4], y: item.transform[5] }]
  })
}

async function extractGoldOptionPages(pdf) {
  const firstPage = await extractPageItems(pdf, 1)
  const selected = [firstPage]
  let sawPut = false
  let sawCall = false
  let missesAfterChain = 0
  for (let pageNumber = 2; pageNumber <= pdf.numPages; pageNumber += 1) {
    const items = await extractPageItems(pdf, pageNumber)
    const text = items.map((item) => item.str.trim()).filter(Boolean).join(' ')
    const hasPut = /\bOG\s+PUT\s+COMEX\s+GOLD\s+OPTIONS\b/.test(text)
    const hasCall = /\bOG\s+CALL\s+COMEX\s+GOLD\s+OPTIONS\b/.test(text)
    if (hasPut || hasCall) {
      selected.push(items)
      sawPut ||= hasPut
      sawCall ||= hasCall
      missesAfterChain = 0
    } else if (sawPut && sawCall && ++missesAfterChain >= 2) break
  }
  return selected
}

function rows(items) {
  const sorted = [...items].filter((item) => item.str.trim()).sort((a, b) => b.y - a.y || a.x - b.x)
  const grouped = []
  for (const item of sorted) {
    const row = grouped.at(-1)
    if (!row || Math.abs(row.y - item.y) > 1.1) grouped.push({ y: item.y, items: [item] })
    else row.items.push(item)
  }
  return grouped.map((row) => row.items.sort((a, b) => a.x - b.x))
}

const rowText = (row) => row.map((item) => item.str.trim()).filter(Boolean).join(' ')
const monthToken = (value) => /^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{2}$/.test(value)
const integer = (value) => value && /^\d[\d,]*$/.test(value) ? Number(value.replaceAll(',', '')) : null

function isoDate(month, day, year) {
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return date.toISOString().slice(0, 10)
}

function expiryMap(firstPageRows) {
  const header = firstPageRows.find((row) => row.filter((item) => monthToken(item.str.trim())).length >= 8)
  const ogCall = firstPageRows.find((row) => /^OG\s+CALL(?:\s|$)/.test(rowText(row)) && row.some((item) => /^\d{2}\/\d{2}$/.test(item.str.trim())))
  if (!header || !ogCall) return new Map()
  const contracts = header.filter((item) => monthToken(item.str.trim()))
  const expirations = ogCall.filter((item) => /^\d{2}\/\d{2}$/.test(item.str.trim()))
  const result = new Map()
  for (const expiry of expirations) {
    const contract = contracts.reduce((nearest, candidate) => Math.abs(candidate.x - expiry.x) < Math.abs(nearest.x - expiry.x) ? candidate : nearest)
    if (Math.abs(contract.x - expiry.x) > 2) continue
    const token = contract.str.trim()
    const contractMonth = MONTHS.indexOf(token.slice(0, 3)) + 1
    const contractYear = 2000 + Number(token.slice(3))
    const [expiryMonth, expiryDay] = expiry.str.trim().split('/').map(Number)
    const parsed = isoDate(expiryMonth, expiryDay, expiryMonth > contractMonth ? contractYear - 1 : contractYear)
    if (parsed) result.set(token, parsed)
  }
  return result
}

function tradeDate(firstPageRows) {
  for (const row of firstPageRows) {
    const match = rowText(row).match(/(?:Mon|Tue|Wed|Thu|Fri),\s+([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})/)
    if (!match) continue
    return isoDate(MONTHS.indexOf(match[1].toUpperCase()) + 1, Number(match[2]), Number(match[3]))
  }
  return null
}

function parse(pages, fetchedAt) {
  const pageRows = pages.map(rows)
  const date = tradeDate(pageRows[0])
  const expiries = expiryMap(pageRows[0])
  if (!date || !expiries.size) throw new Error('bulletin header validation failed')
  let side = null
  let contractMonth = null
  const contracts = []
  for (const page of pageRows) {
    for (const row of page) {
      const product = rowText(row).match(/^([A-Z0-9]+)\s+(CALL|PUT)\s+(?:COMEX\s+)?GOLD\s+OPTIONS/)
      if (product) {
        side = product[1] === 'OG' ? product[2].toLowerCase() : null
        contractMonth = null
        continue
      }
      const possibleMonth = row.find((item) => item.x < 40 && monthToken(item.str.trim()))?.str.trim()
      if (possibleMonth) {
        contractMonth = side && expiries.has(possibleMonth) ? possibleMonth : null
        continue
      }
      if (!side || !contractMonth) continue
      const strikeItem = row.find((item) => item.x < 35 && /^\d{3,5}$/.test(item.str.trim()))
      if (!strikeItem) continue
      const volume = integer(row.find((item) => item.x >= 480 && item.x < 520)?.str.trim()) ?? 0
      const openInterest = integer(row.find((item) => item.x >= 540 && item.x < 566)?.str.trim()) ?? 0
      if (!volume && !openInterest) continue
      const strike = Number(strikeItem.str.trim())
      const month = MONTHS.indexOf(contractMonth.slice(0, 3))
      contracts.push({
        contractSymbol: `${contractMonth}|${strike}${side === 'call' ? 'C' : 'P'}`,
        underlyingContract: `GC${FUTURES_MONTH_CODES[month]}${contractMonth.slice(3)}`,
        type: side,
        strike,
        expiry: expiries.get(contractMonth),
        volume,
        openInterest,
        tradeDate: date,
        source: 'cme_bulletin',
        fetchedAt: fetchedAt.toISOString(),
      })
    }
  }
  return contracts
}

const now = new Date()
const response = await fetch(ENDPOINT, { headers: { accept: 'application/pdf,*/*;q=0.8', 'user-agent': 'AlphaSeekerMarketData/1.0' } })
if (!response.ok) throw new Error(`CME HTTP ${response.status}`)
const bytes = new Uint8Array(await response.arrayBuffer())
if (new TextDecoder().decode(bytes.slice(0, 4)) !== '%PDF') throw new Error('invalid PDF')
const pdf = await getDocumentProxy(bytes)
if (pdf.numPages > 100) throw new Error('unexpected page count')
const relevantPages = await extractGoldOptionPages(pdf)
const all = parse(relevantPages, now)
const grouped = Object.groupBy(all, (contract) => `${contract.expiry}|${contract.underlyingContract}`)
const selected = Object.values(grouped)
  .filter(Boolean)
  .filter((group) => {
    const dte = Math.ceil((new Date(`${group[0].expiry}T00:00:00Z`) - now) / 86_400_000)
    return dte >= 5 && dte <= 45 && group.filter((item) => item.type === 'call').length >= 3 && group.filter((item) => item.type === 'put').length >= 3
  })
  .sort((a, b) => a[0].expiry.localeCompare(b[0].expiry))[0]
if (!selected?.length) throw new Error('no valid 5–45 DTE chain')
await mkdir('data', { recursive: true })
await writeFile('data/gc-options.json', `${JSON.stringify({ version: 1, generatedAt: now.toISOString(), contracts: selected })}\n`)
console.log(`published ${selected.length} contracts for ${selected[0].underlyingContract} expiring ${selected[0].expiry}`)
