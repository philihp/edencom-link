// EVE mail bodies to plain text and back (src/mailText.ts): what read_mail
// shows a model, and what send_mail turns a model's text into.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mailText, textToMailBody } from '../src/mailText.ts'

test('no body reads as null, an empty one as empty text', () => {
  assert.equal(mailText(null), null)
  assert.equal(mailText(undefined), null)
  assert.equal(mailText(''), '')
})

test('<br> in any spelling is a line break', () => {
  assert.equal(mailText('one<br>two<BR/>three<br />four'), 'one\ntwo\nthree\nfour')
})

test('font and other formatting tags go, their text stays', () => {
  assert.equal(
    mailText('<font size="12" color="#bfffffff">Fuel is <b>low</b> at </font><font color="#ffd98d00">C-J6MT</font>'),
    'Fuel is low at C-J6MT'
  )
})

test('an in-game link keeps only its text', () => {
  assert.equal(
    mailText('Ask <a href="showinfo:1377//2112345678">Sir Cuddles</a> about the <a href="killReport:123:abc">kill</a>'),
    'Ask Sir Cuddles about the kill'
  )
})

test('a web link keeps its address after the text, unless the text is the address', () => {
  assert.equal(
    mailText('Read <a href="https://edencom.link/structure">the ledger</a>.'),
    'Read the ledger (https://edencom.link/structure).'
  )
  assert.equal(mailText("<a href='https://edencom.link'>https://edencom.link</a>"), 'https://edencom.link')
})

test('a link whose text is itself formatted keeps the plain text', () => {
  assert.equal(mailText('<a href="showinfo:5//30000142"><font color="#ffd98d00">Jita</font></a>'), 'Jita')
})

test('entities decode once, after the tags are gone', () => {
  assert.equal(mailText('5 &lt; 7 &amp;&amp; 7 &gt; 5'), '5 < 7 && 7 > 5')
  assert.equal(mailText('&amp;lt;b&amp;gt;'), '&lt;b&gt;')
  assert.equal(mailText('&quot;o7&quot; &#39;o7&#39; &#x2014; &nbsp;'), '"o7" \'o7\' —')
  assert.equal(mailText('&lt;b&gt;not bold&lt;/b&gt;'), '<b>not bold</b>')
})

test('an unknown entity is left as written', () => {
  assert.equal(mailText('&bogus; &#0;'), '&bogus; &#0;')
})

test('blank lines collapse to one, trailing spaces and outer whitespace go', () => {
  assert.equal(mailText('  hello   <br><br><br><br>world  \r\n\r\n\r\nagain  '), 'hello\n\nworld\n\nagain')
})

test('text becomes a body with <br> line breaks and markup escaped', () => {
  assert.equal(
    textToMailBody('o7\nFuel at <C-J6MT> & Jita\r\nfly safe'),
    'o7<br>Fuel at &lt;C-J6MT&gt; &amp; Jita<br>fly safe'
  )
})

test('a text body survives the round trip', () => {
  const text = 'Line one\n\nLine <two> & "three"'
  assert.equal(mailText(textToMailBody(text)), text)
})
