/**
 * KML / GeoJSON 范围导入的单元测试（Node 直跑）。
 *
 * 重点覆盖两件事：
 * 1. **三维坐标必须被剥成两维** —— 大疆/Google Earth 导出的 KML 是 lon,lat,alt，
 *    第 3 维混进 geometry 会让面积与 Terra Draw 全算错。
 * 2. **多多边形取最大** —— 一个 KML 里常有"目标区块 + 图例框"，合并会虚增范围。
 */
import { parseKmlOrGeoJsonRoi, RoiImportError } from '../src/lib/roiImport'

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${label}${detail ? '  ·  ' + detail : ''}`)
  if (!ok) failures++
}

function expectThrow(fn: () => void, keyword: string, label: string): void {
  try {
    fn()
    check(false, label, '应当抛错但没抛')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    check(e instanceof RoiImportError, label, msg.slice(0, 60))
    check(msg.includes(keyword), `  错误信息含「${keyword}」`, msg.slice(0, 70))
  }
}

const KML_3D = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark>
      <name>Block A 东区</name>
      <Polygon><outerBoundaryIs><LinearRing><coordinates>
        111.200,1.180,0 111.210,1.180,0 111.210,1.190,12.5 111.200,1.190,0 111.200,1.180,0
      </coordinates></LinearRing></outerBoundaryIs></Polygon>
    </Placemark>
  </Document>
</kml>`

// ---------- A. KML 三维坐标 ----------
console.log('\nA. KML：三维坐标必须剥成两维')
{
  const r = parseKmlOrGeoJsonRoi(KML_3D, 'block-a.kml')
  check(r.source === 'kml', '识别为 kml')
  check(r.geometry.type === 'Polygon', '返回 Polygon')
  const ring = r.geometry.coordinates[0]
  check(ring.every((p) => p.length === 2), '★ 所有顶点只有 2 维（alt 已丢弃）', `首点 ${JSON.stringify(ring[0])}`)
  check(r.strippedAltitude === true, '标记了「已忽略高程」')
  check(r.name === 'Block A 东区', '取到 Placemark 名称', r.name)
  check(ring.length === 5, '顶点数 5（闭合环）', String(ring.length))
  const first = ring[0]
  const last = ring[ring.length - 1]
  check(first[0] === last[0] && first[1] === last[1], '环自动闭合')
}

// ---------- B. 多多边形取最大 ----------
console.log('\nB. KML：多个多边形取面积最大的')
{
  const kml = `<kml><Document>
    <Placemark><name>图例框</name><Polygon><outerBoundaryIs><LinearRing><coordinates>
      111.0,1.0,0 111.001,1.0,0 111.001,1.001,0 111.0,1.001,0 111.0,1.0,0
    </coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
    <Placemark><name>目标区块</name><Polygon><outerBoundaryIs><LinearRing><coordinates>
      111.20,1.18,0 111.30,1.18,0 111.30,1.28,0 111.20,1.28,0 111.20,1.18,0
    </coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
  </Document></kml>`
  const r = parseKmlOrGeoJsonRoi(kml, 'two.kml')
  check(r.polygonCount === 2, '识别出 2 个多边形', String(r.polygonCount))
  const ring = r.geometry.coordinates[0]
  const maxLon = Math.max(...ring.map((p) => p[0]))
  check(maxLon > 111.29, '★ 取的是大块（111.30），不是图例框', String(maxLon))
}

// ---------- C. KML 坐标换行 / 缩进 ----------
console.log('\nC. KML：坐标里的换行与缩进')
{
  const kml = `<kml><Polygon><outerBoundaryIs><LinearRing><coordinates>
    111.21,1.19,0
    111.22,1.19,0
    111.22,1.20,0
    111.21,1.20,0
    111.21,1.19,0
  </coordinates></LinearRing></outerBoundaryIs></Polygon></kml>`
  const r = parseKmlOrGeoJsonRoi(kml)
  check(r.geometry.coordinates[0].length === 5, '换行分隔也能解析', String(r.geometry.coordinates[0].length))
}

// ---------- D. GeoJSON ----------
console.log('\nD. GeoJSON：FeatureCollection / Feature / MultiPolygon')
{
  const fc = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { name: '小块' },
        geometry: {
          type: 'Polygon',
          coordinates: [[[111.0, 1.0], [111.001, 1.0], [111.001, 1.001], [111.0, 1.001], [111.0, 1.0]]],
        },
      },
      {
        type: 'Feature',
        properties: { name: '大块' },
        geometry: {
          type: 'Polygon',
          coordinates: [[[111.2, 1.18], [111.3, 1.18], [111.3, 1.28], [111.2, 1.28], [111.2, 1.18]]],
        },
      },
    ],
  }
  const r = parseKmlOrGeoJsonRoi(JSON.stringify(fc), 'x.geojson')
  check(r.source === 'geojson', '识别为 geojson')
  check(r.name === '大块', '取到最大块的 name', r.name)
  check(r.polygonCount === 2, '两个候选都数到了')

  // 未闭合的三角形（3 个顶点）→ 自动补一个闭合点
  const single = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [[[111.2, 1.18], [111.21, 1.18], [111.21, 1.19]]] },
  }
  const r2 = parseKmlOrGeoJsonRoi(JSON.stringify(single))
  check(r2.geometry.coordinates[0].length === 4, '未闭合三角形自动补闭合点（3 → 4）', String(r2.geometry.coordinates[0].length))

  const mp = {
    type: 'MultiPolygon',
    coordinates: [
      [[[111.0, 1.0], [111.001, 1.0], [111.001, 1.001], [111.0, 1.0]]],
      [[[111.2, 1.18], [111.25, 1.18], [111.25, 1.23], [111.2, 1.23], [111.2, 1.18]]],
    ],
  }
  const r3 = parseKmlOrGeoJsonRoi(JSON.stringify(mp))
  check(Math.max(...r3.geometry.coordinates[0].map((p) => p[0])) > 111.24, 'MultiPolygon 取最大的一瓣')
}

// ---------- E. GeoJSON 三维坐标 ----------
console.log('\nE. GeoJSON：带第三维的坐标也要剥掉')
{
  const g = {
    type: 'Polygon',
    coordinates: [[[111.2, 1.18, 0], [111.21, 1.18, 0], [111.21, 1.19, 5], [111.2, 1.18, 0]]],
  }
  const r = parseKmlOrGeoJsonRoi(JSON.stringify(g))
  check(r.geometry.coordinates[0].every((p) => p.length === 2), '★ 三维 GeoJSON 也被剥成两维')
  check(r.strippedAltitude === true, '标记了「已忽略高程」')
}

// ---------- F. 错误处理 ----------
console.log('\nF. 错误处理（给用户可读的原因）')
{
  expectThrow(() => parseKmlOrGeoJsonRoi('', 'x.kml'), '空的', '空文件')
  expectThrow(
    () => parseKmlOrGeoJsonRoi('<kml><Document></Document></kml>', 'x.kml'),
    'coordinates',
    'KML 没有坐标（多半是 KMZ）',
  )
  expectThrow(
    () =>
      parseKmlOrGeoJsonRoi(
        JSON.stringify({
          type: 'Polygon',
          // UTM 米坐标被当成经纬度
          coordinates: [[[500000, 130000], [500100, 130000], [500100, 130100], [500000, 130000]]],
        }),
        'utm.geojson',
      ),
    '投影坐标',
    'UTM 米坐标必须被拦住',
  )
  expectThrow(
    () => parseKmlOrGeoJsonRoi(JSON.stringify({ type: 'Point', coordinates: [111, 1] }), 'p.geojson'),
    'Polygon',
    '只有点没有面',
  )
  expectThrow(() => parseKmlOrGeoJsonRoi('{不是 json', 'x.geojson'), 'JSON', '坏 JSON')
}

// ---------- 汇总 ----------
console.log()
if (failures === 0) {
  console.log('✅ 全部通过')
} else {
  console.log(`❌ ${failures} 项失败`)
  process.exitCode = 1
}
