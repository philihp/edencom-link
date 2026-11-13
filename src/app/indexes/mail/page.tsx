// /indexes/mail — the EVE mail our characters received in the window, each
// with the reply or replies we sent to it (docs/eve-mail.md). Reads only the
// owner's own copy (character_mail) and send log (mail_send_log) on the
// cookie session, so RLS keeps it to the caller's characters; which mail
// answers which is the pure fold in replies.ts.
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { chain, map, splitEvery, uniq } from 'ramda'

import { mailText } from '@/mailText'
import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../../account/lib/establishedUser'
import { DateTime } from '../../DateTime'
import { timeWindowDays } from '../../timeWindow'
import { Name } from '../../names'
import { UrlWindowSelect } from '../../windowSelect'
import {
  countThreads,
  foldReceived,
  type MailRow,
  ourMails,
  type Recipient,
  type Reply,
  type SendLogRow,
  type Thread,
  threadReplies,
} from './replies'
import styles from './mail.module.css'

export const dynamic = 'force-dynamic'

const DEFAULT_DAYS = 14
// The newest received copies read: a corporation mail is one row per alt
// holding it, so this is a cap on rows, not on mails.
const MAX_RECEIVED_ROWS = 500
const MAX_SENT_ROWS = 1000
const IN_CHUNK = 300
const MAIL_COLUMNS = 'registration_id, mail_id, from_id, subject, sent_at, is_read, recipients, body'

type Supabase = Awaited<ReturnType<typeof createClient>>
type NameBook = { names: Map<number, string>; lists: Map<number, string>; characters: Map<string, string> }

const rowsOf = <T,>(result: { data: unknown; error: { message: string } | null }, what: string): T[] => {
  if (result.error) throw new Error(`reading ${what} failed: ${result.error.message}`)
  return (result.data ?? []) as T[]
}

const readInChunks = async <T,>(ids: number[], read: (chunk: number[]) => PromiseLike<T[]>): Promise<T[]> =>
  ids.length === 0 ? [] : (await Promise.all(map(read, splitEvery(IN_CHUNK, ids)))).flat()

const fetchNameBook = async (
  supabase: Supabase,
  ids: number[],
  characters: Array<{ id: string; character_id: number | string; name: string | null }>
): Promise<NameBook> => {
  const registrationIds = map((c) => c.id, characters)
  const [universe, directory, lists] = await Promise.all([
    readInChunks(ids, async (chunk) =>
      rowsOf<{ id: number | string; name: string }>(
        await supabase.from('universe_name').select('id, name').in('id', chunk),
        'names'
      )
    ),
    readInChunks(ids, async (chunk) =>
      rowsOf<{ character_id: number | string; name: string | null }>(
        await supabase.from('character_directory').select('character_id, name').in('character_id', chunk),
        'the character directory'
      )
    ),
    registrationIds.length === 0
      ? Promise.resolve([])
      : supabase
          .from('character_mailing_list')
          .select('mailing_list_id, name')
          .in('registration_id', registrationIds)
          .then((r) => rowsOf<{ mailing_list_id: number | string; name: string | null }>(r, 'mailing lists')),
  ])
  return {
    names: new Map<number, string>([
      ...chain((d): Array<[number, string]> => (d.name ? [[Number(d.character_id), d.name]] : []), directory),
      ...chain((c): Array<[number, string]> => (c.name ? [[Number(c.character_id), c.name]] : []), characters),
      ...map((u): [number, string] => [Number(u.id), u.name], universe),
    ]),
    lists: new Map(chain((l): Array<[number, string]> => (l.name ? [[Number(l.mailing_list_id), l.name]] : []), lists)),
    characters: new Map(map((c): [string, string] => [c.id, c.name ?? String(c.character_id)], characters)),
  }
}

const recipientName = (book: NameBook) => (r: Recipient) =>
  (r.type === 'mailing_list' ? book.lists.get(r.id) : book.names.get(r.id)) ?? `#${r.id}`

const STATUS_LABEL: Record<Reply['status'], string> = {
  sent: 'sent',
  queued: 'in outbox',
  pending: 'sending',
  error: 'failed',
}

const Body = ({ body, summary }: { body: string | null; summary: string }) => {
  const text = mailText(body)
  return text ? (
    <details className={styles.body}>
      <summary>{summary}</summary>
      <pre>{text}</pre>
    </details>
  ) : (
    <div className={styles.noBody}>body not copied yet</div>
  )
}

const ReplyItem = ({ reply, book }: { reply: Reply; book: NameBook }) => (
  <li className={styles.reply}>
    <div className={styles.meta}>
      <DateTime value={reply.sentAt} /> · <Name name={book.characters.get(reply.registrationId)} /> →{' '}
      {map(recipientName(book), reply.recipients).join(', ')}{' '}
      <span className={styles.status} data-status={reply.status} title={reply.error ?? undefined}>
        {STATUS_LABEL[reply.status]}
      </span>
    </div>
    <div className={styles.subject}>{reply.subject || '(no subject)'}</div>
    <Body body={reply.body} summary="reply" />
  </li>
)

const ThreadItem = ({ thread, book }: { thread: Thread; book: NameBook }) => {
  const { received, replies } = thread
  return (
    <li className={styles.thread}>
      <div className={styles.meta}>
        <DateTime value={received.sentAt} /> · <Name name={book.names.get(received.fromId)} id={received.fromId} /> →{' '}
        {uniq(map((id) => book.characters.get(id) ?? id, received.holders)).join(', ')}
        {replies.length === 0 && <span className={styles.unanswered}>no reply</span>}
      </div>
      <div className={styles.subject}>{received.subject || '(no subject)'}</div>
      <Body body={received.body} summary="mail" />
      {replies.length > 0 && (
        <ul className={styles.replies}>
          {map(
            (r) => (
              <ReplyItem key={r.key} reply={r} book={book} />
            ),
            replies
          )}
        </ul>
      )}
    </li>
  )
}

const MailRepliesPage = async ({ searchParams }: { searchParams: Promise<{ days?: string }> }) => {
  const { days: daysParam } = await searchParams
  const days = timeWindowDays(daysParam, DEFAULT_DAYS)
  const since = new Date(Date.now() - days * 86_400_000).toISOString()

  const supabase = await createClient()
  const user = await establishedUser(supabase)
  if (!user) redirect('/')

  const characters = rowsOf<{ id: string; character_id: number | string; name: string | null }>(
    await supabase.from('registration').select('id, character_id, name').not('character_id', 'is', null),
    'your characters'
  )
  const ownIds = map((c) => Number(c.character_id), characters)
  const own = new Set(ownIds)
  const ownList = `(${ownIds.join(',')})`

  // Received and sent are two reads so a busy corporation inbox cannot crowd
  // our own sent mail out of one capped page.
  const [receivedRows, sentRows, logRows] =
    ownIds.length === 0
      ? ([[], [], []] as [MailRow[], MailRow[], SendLogRow[]])
      : await Promise.all([
          supabase
            .from('character_mail')
            .select(MAIL_COLUMNS)
            .not('from_id', 'in', ownList)
            .gte('sent_at', since)
            .order('sent_at', { ascending: false })
            .limit(MAX_RECEIVED_ROWS)
            .then((r) => rowsOf<MailRow>(r, 'received mail')),
          supabase
            .from('character_mail')
            .select(MAIL_COLUMNS)
            .in('from_id', ownIds)
            .gte('sent_at', since)
            .order('sent_at', { ascending: false })
            .limit(MAX_SENT_ROWS)
            .then((r) => rowsOf<MailRow>(r, 'sent mail')),
          supabase
            .from('mail_send_log')
            .select('id, registration_id, mail_id, subject, body, recipients, status, error, created_at, finished_at')
            .gte('created_at', since)
            .order('created_at', { ascending: false })
            .limit(MAX_SENT_ROWS)
            .then((r) => rowsOf<SendLogRow>(r, 'the send log')),
        ])

  const threads = threadReplies(foldReceived(receivedRows, own), ourMails(sentRows, logRows, own))
  const counts = countThreads(threads)
  const book = await fetchNameBook(
    supabase,
    uniq([
      ...map((t) => t.received.fromId, threads),
      ...chain((t) => chain((r) => map((x) => x.id, r.recipients), t.replies), threads),
    ]),
    characters
  )

  return (
    <>
      <div className={styles.pageHeader}>
        <div>
          <h1>Mail replies</h1>
          <div className={styles.subtitle}>
            {counts.received} mail{counts.received === 1 ? '' : 's'} received · {counts.answered} answered ·{' '}
            {counts.replies} repl{counts.replies === 1 ? 'y' : 'ies'} · <Link href="/indexes">&laquo; indexes</Link>
          </div>
        </div>
        <UrlWindowSelect days={days} path="/indexes/mail" />
      </div>
      <p className={styles.note}>
        EVE mail has no reply link, so a reply is a mail of ours sent after it, to its sender, on the same subject once
        &ldquo;Re:&rdquo; is taken off. The mail copy is refreshed every 6 hours, for characters with the &ldquo;Read
        in-game mail&rdquo; grant.
      </p>
      {threads.length > 0 ? (
        <ul className={styles.threads}>
          {map(
            (t) => (
              <ThreadItem key={t.received.mailId} thread={t} book={book} />
            ),
            threads
          )}
        </ul>
      ) : (
        <p>No mail received in the last {days === 1 ? 'day' : `${days} days`}.</p>
      )}
    </>
  )
}
export default MailRepliesPage
