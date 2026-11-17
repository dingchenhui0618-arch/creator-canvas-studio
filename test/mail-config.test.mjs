import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 邮件通道的保存口径：
//   1) 口令是凭证，接口只回「有没有」，落盘 0600；
//   2) 账号留空 = 沿用已保存的账号——后台表单不回显账号，只改端口 / 发件人时不该逼人重填，
//      更不该因为账号空着就把口令丢掉（真实踩过：改端口重存后发不出信）；
//   3) 真换了账号又没给新口令，要当场报错，而不是保存成功、发信时才 535。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-mailcfg-'))
process.env.DATA_DIR = dir

const mailConfig = await import('../server/mail-config.mjs')
const AT = String.fromCharCode(64)
const FROM = 'noreply' + AT + 'mail.example.test'
const OTHER = 'ops' + AT + 'mail.example.test'
const PASS = 'SmtpPass12345'

function clear() {
  fs.rmSync(path.join(dir, 'mail.json'), { force: true })
}

test('保存通道：口令只落盘不回显，文件 0600', async () => {
  clear()
  const saved = await mailConfig.saveMail(
    { host: 'smtpdm.aliyun.com', port: 465, secure: true, user: FROM, pass: PASS, fromName: 'VisionQA', fromAddress: FROM },
    { by: 'admin' + AT + 'example.test' },
  )
  assert.equal(saved.ok, true, saved.error)
  assert.equal(saved.passKept, false)
  assert.equal(saved.mail.user, FROM, '落盘的账号就是发信账号')
  assert.equal(saved.mail.pass, PASS, '落盘有口令（maskAccount 只在视图层做）')
  assert.equal(saved.mail.secure, true)
  assert.equal(saved.mail.starttls, false, '直连 TLS 不该再开 STARTTLS')

  const mode = fs.statSync(path.join(dir, 'mail.json')).mode & 0o777
  if (process.platform !== 'win32') assert.equal(mode, 0o600, '凭证文件必须是 0600')
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'mail.json'), 'utf8'))
  assert.equal(raw.pass, PASS)
})

test('账号留空 = 沿用已保存的账号与口令（只改端口不用重填）', async () => {
  clear()
  const first = await mailConfig.saveMail({ host: 'smtp.old.test', port: 587, user: FROM, pass: PASS, fromAddress: FROM })
  assert.equal(first.ok, true, first.error)

  const second = await mailConfig.saveMail({ host: 'smtp.new.test', port: 465, secure: true, user: '', pass: '', fromAddress: FROM })
  assert.equal(second.ok, true, second.error)
  assert.equal(second.passKept, true, '没给新口令就该沿用旧口令')
  assert.equal(second.mail.host, 'smtp.new.test')
  assert.equal(second.mail.user, FROM, '账号留空时沿用上一次的账号')
  assert.equal(second.mail.pass, PASS, '口令不该被空值冲掉')
})

test('换了账号又不填口令：当场报错，不保存', async () => {
  clear()
  await mailConfig.saveMail({ host: 'smtp.example.test', port: 465, secure: true, user: FROM, pass: PASS, fromAddress: FROM })
  const before = fs.readFileSync(path.join(dir, 'mail.json'), 'utf8')
  const bad = await mailConfig.saveMail({ host: 'smtp.example.test', port: 465, secure: true, user: OTHER, pass: '', fromAddress: OTHER })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /重新填口令/)
  assert.equal(fs.readFileSync(path.join(dir, 'mail.json'), 'utf8'), before, '校验失败不该动已保存的配置')
})

test('没配过通道时账号留空也保存得了（无认证中继）', async () => {
  clear()
  const saved = await mailConfig.saveMail({ host: '127.0.0.1', port: 25, user: '', pass: '', fromAddress: FROM })
  assert.equal(saved.ok, true, saved.error)
  assert.equal(saved.mail.user, '')
  assert.equal(saved.mail.pass, '')
  assert.equal(saved.mail.starttls, true, '非直连 TLS 默认走 STARTTLS')
})

test('发件地址不合法 / 服务器地址不合法：给能看懂的错误', async () => {
  clear()
  const badFrom = await mailConfig.saveMail({ host: 'smtp.example.test', port: 465, secure: true, user: FROM, pass: PASS, fromAddress: 'not-an-address' })
  assert.equal(badFrom.ok, false)
  assert.match(badFrom.error, /发件地址/)
  const badHost = await mailConfig.saveMail({ host: 'smtp example', port: 465, user: FROM, pass: PASS, fromAddress: FROM })
  assert.equal(badHost.ok, false)
  assert.match(badHost.error, /服务器地址/)

  const config = await mailConfig.readMail()
  assert.equal(config, null, '没保存成功就不该留下半个文件')
})

test('清掉通道后找回密码侧读不到配置', async () => {
  clear()
  await mailConfig.saveMail({ host: 'smtp.example.test', port: 465, secure: true, user: FROM, pass: PASS, fromAddress: FROM })
  assert.ok(await mailConfig.readMail())
  await mailConfig.clearMail()
  assert.equal(await mailConfig.readMail(), null)
  assert.equal(fs.existsSync(path.join(dir, 'mail.json')), false)
})
