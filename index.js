import express from 'express'
import getRawBody from 'raw-body'
import crypto from 'crypto'
import fetch from 'node-fetch'
import { createClient } from '@supabase/supabase-js'

const app = express()
const PORT = process.env.PORT || 8080

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN
const VERCEL_API_URL = process.env.VERCEL_API_URL

console.log('VERCEL_API_URL:', VERCEL_API_URL)

if (!VERCEL_API_URL) {
  console.error('ERROR: VERCEL_API_URL 環境変数が設定されていません。必ず Railway の環境変数に設定してください。')
  process.exit(1)
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

function verifySignature(bodyBuffer, signature) {
  const hash = crypto
    .createHmac('SHA256', LINE_CHANNEL_SECRET)
    .update(bodyBuffer)
    .digest('base64')
  return hash === signature
}

async function replyToLine(replyToken, messages) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  })
  if (!res.ok) {
    const text = await res.text()
    console.error('LINE reply error:', text)
  } else {
    console.log('LINE reply sent successfully')
  }
}

app.post('/api/line-webhook', async (req, res) => {
  try {
    const bodyBuffer = await getRawBody(req)
    const signature = req.headers['x-line-signature']

    console.log('Webhook request received')
    console.log('Raw body:', bodyBuffer.toString())

    if (!verifySignature(bodyBuffer, signature)) {
      console.warn('Unauthorized signature')
      return res.status(401).send('Unauthorized')
    }

    const body = JSON.parse(bodyBuffer.toString())
    console.log('Parsed webhook body:', JSON.stringify(body, null, 2))

    for (const event of body.events) {
      if (event.type !== 'message' || event.message.type !== 'text') {
        continue
      }

      const lineUserId = event.source.userId
      const text = event.message.text.trim()
      const replyToken = event.replyToken

      console.log(`Message from user ${lineUserId}: "${text}"`)

      // 途中でやめるコマンド対応
      const cancelCommands = ['やめる', 'キャンセル', '終了']
      if (cancelCommands.includes(text)) {
        // 未完了セッション取得
        const { data: sessions, error: sessionError } = await supabase
          .from('line_message_sessions')
          .select('*')
          .eq('line_user_id', lineUserId)
          .neq('status', 'completed')
          .order('created_at', { ascending: false })
          .limit(1)

        if (sessionError) {
          console.error('Error fetching sessions for cancel:', sessionError)
          await replyToLine(replyToken, [{ type: 'text', text: 'システムエラーが発生しました。' }])
          continue
        }

        const lastSession = sessions?.[0]

        if (lastSession && lastSession.status !== 'completed') {
          await supabase
            .from('line_message_sessions')
            .update({ status: 'completed' })
            .eq('id', lastSession.id)
        }

        await replyToLine(replyToken, [
          { type: 'text', text: '終了しました。また必要な時にご利用ください。' },
        ])
        continue
      }

      // user_profilesにLINEユーザーID紐づくユーザー確認
      const { data: profiles, error: profileError } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('line_user_id', lineUserId)
        .limit(1)

      if (profileError) {
        console.error('Error fetching user_profiles:', profileError)
        await replyToLine(replyToken, [{ type: 'text', text: 'システムエラーが発生しました。' }])
        continue
      }

      let userProfile = profiles?.[0]

      // 未完了セッション取得 (completed除外)
      const { data: sessions, error: sessionError } = await supabase
        .from('line_message_sessions')
        .select('*')
        .eq('line_user_id', lineUserId)
        .neq('status', 'completed')
        .order('created_at', { ascending: false })
        .limit(1)

      if (sessionError) {
        console.error('Error fetching sessions:', sessionError)
        await replyToLine(replyToken, [{ type: 'text', text: 'システムエラーが発生しました。' }])
        continue
      }

      let lastSession = sessions?.[0]

      // 未登録ユーザー（user_profilesなし）
      if (!userProfile) {
        if (!lastSession) {
          // 新規セッション開始：メール入力を促す
          const { error: insertError } = await supabase.from('line_message_sessions').insert([
            {
              line_user_id: lineUserId,
              reply_token: replyToken,
              status: 'waiting_for_email',
              created_at: new Date().toISOString(),
            },
          ])

          if (insertError) {
            console.error('Failed to insert line_message_sessions:', insertError)
            await replyToLine(replyToken, [{ type: 'text', text: 'システムエラーが発生しました。' }])
            continue
          }

          await replyToLine(replyToken, [
            {
              type: 'text',
              text: 'こんにちは！このBotを使うにはメールアドレスを入力してください。',
            },
          ])
          continue
        }

        // メール入力待ち
        if (lastSession.status === 'waiting_for_email') {
          const email = text
          console.log(`Received email: ${email}`)

          // 簡易メール形式チェック
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            await replyToLine(replyToken, [{ type: 'text', text: '有効なメールアドレスを入力してください。' }])
            continue
          }

          // Supabase auth.admin.listUsers で全ユーザー取得してからメールでフィルター
          const { data, error: listUsersError } = await supabase.auth.admin.listUsers()

          if (listUsersError) {
            console.error('Supabase auth.admin.listUsers error:', listUsersError)
            await replyToLine(replyToken, [{ type: 'text', text: 'システムエラーが発生しました。' }])
            continue
          }

          const users = data?.users.filter((u) => u.email === email) || []

          if (users.length === 0) {
            await replyToLine(replyToken, [
              {
                type: 'text',
                text: 'このメールアドレスは登録されていません。管理者にお問い合わせください。',
              },
            ])
            continue
          }

          const user = users[0]

          // user_profiles登録チェック・登録
          const { data: existingProfiles, error: profileCheckError } = await supabase
            .from('user_profiles')
            .select('id')
            .eq('user_id', user.id)
            .limit(1)

          if (profileCheckError) {
            console.error('Error checking user_profiles:', profileCheckError)
            await replyToLine(replyToken, [{ type: 'text', text: 'システムエラーが発生しました。' }])
            continue
          }

          if (!existingProfiles || existingProfiles.length === 0) {
            const { error: insertError } = await supabase.from('user_profiles').insert([
              {
                user_id: user.id,
                line_user_id: lineUserId,
                display_name: user.email,
                created_at: new Date().toISOString(),
              },
            ])

            if (insertError) {
              console.error('Failed to insert user_profile:', insertError)
              await replyToLine(replyToken, [
                { type: 'text', text: 'プロフィール登録に失敗しました。管理者にお問い合わせください。' },
              ])
              continue
            }
          }

          // セッションをメール認証済み -> 次ステップへ更新
          await supabase
            .from('line_message_sessions')
            .update({ user_id: user.id, status: 'waiting_for_use_confirmation' })
            .eq('id', lastSession.id)

          await replyToLine(replyToken, [
            {
              type: 'text',
              text: '認証が完了しました。返信生成AIを使用しますか？',
              quickReply: {
                items: [
                  { type: 'action', action: { type: 'message', label: 'はい', text: 'はい' } },
                  { type: 'action', action: { type: 'message', label: 'いいえ', text: 'いいえ' } },
                ],
              },
            },
          ])

          continue
        }

        // その他の状態ならメール入力を促す（無限ループ対策で簡単に）
        await replyToLine(replyToken, [{ type: 'text', text: 'メールアドレスを送信してください。' }])
        continue
      }

      // 登録済みユーザーのセッション処理
      if (!lastSession || lastSession.status === 'completed') {
        // 新規セッション作成
        await supabase.from('line_message_sessions').insert([
          {
            line_user_id: lineUserId,
            user_id: userProfile.user_id,
            reply_token: replyToken,
            status: 'waiting_for_use_confirmation',
            message_text: text,
            created_at: new Date().toISOString(),
          },
        ])

        await replyToLine(replyToken, [
          {
            type: 'text',
            text: '返信生成AIを使用しますか？',
            quickReply: {
              items: [
                { type: 'action', action: { type: 'message', label: 'はい', text: 'はい' } },
                { type: 'action', action: { type: 'message', label: 'いいえ', text: 'いいえ' } },
              ],
            },
          },
        ])
        continue
      }

      if (lastSession.status === 'waiting_for_use_confirmation') {
        if (text === 'はい') {
          const { data: people, error: peopleError } = await supabase
            .from('people')
            .select('id, name')
            .eq('user_id', userProfile.user_id)
            .order('created_at', { ascending: true })

          if (peopleError) {
            console.error('Supabase people fetch error:', peopleError)
            await replyToLine(replyToken, [{ type: 'text', text: 'システムエラーが発生しました。' }])
            continue
          }

          if (!people || people.length === 0) {
            await replyToLine(replyToken, [{ type: 'text', text: '人物が登録されていません。Webで人物を追加してください。' }])
            continue
          }

          await supabase
            .from('line_message_sessions')
            .update({ status: 'waiting_for_person_selection' })
            .eq('id', lastSession.id)

          const quickReplies = people.map((p) => ({
            type: 'action',
            action: { type: 'message', label: p.name, text: `選択:${p.id}` },
          }))

          await replyToLine(replyToken, [
            {
              type: 'text',
              text: '誰のメッセージですか？以下から選択してください。',
              quickReply: { items: quickReplies },
            },
          ])

          continue
        } else {
          await supabase.from('line_message_sessions').update({ status: 'completed' }).eq('id', lastSession.id)
          await replyToLine(replyToken, [{ type: 'text', text: '了解しました。また何かあればお知らせください。' }])
        }
        continue
      }

      if (lastSession.status === 'waiting_for_person_selection') {
        if (text.startsWith('選択:')) {
          const selectedPersonId = text.replace('選択:', '').trim()

          // ここで選択後に「一番最初のメッセージ内容」と「これに対して作成しますか？はい/いいえ」メッセージを送る処理へ変更

          // セッション更新：選択した人物IDと新ステータス
          await supabase
            .from('line_message_sessions')
            .update({
              selected_person_id: selectedPersonId,
              status: 'waiting_for_confirmation',
            })
            .eq('id', lastSession.id)

          // 「一番最初のメッセージ内容」と「これに対して作成しますか？」のQuickReply送信
          await replyToLine(replyToken, [
            {
              type: 'text',
              text: `一番最初のメッセージ内容:\n${lastSession.message_text}\n\nこれに対して作成しますか？`,
              quickReply: {
                items: [
                  { type: 'action', action: { type: 'message', label: 'はい', text: 'はい' } },
                  { type: 'action', action: { type: 'message', label: 'いいえ', text: 'いいえ' } },
                ],
              },
            },
          ])

          continue
        } else {
          await replyToLine(replyToken, [{ type: 'text', text: '人物選択は候補からお選びください。' }])
        }
        continue
      }

      if (lastSession.status === 'waiting_for_confirmation') {
        if (text === 'はい') {
          // そのまま返信生成へ（waiting_for_generated_replyへ）
          await supabase
            .from('line_message_sessions')
            .update({ status: 'waiting_for_generated_reply' })
            .eq('id', lastSession.id)

          // 返信生成API呼び出しは下の waiting_for_generated_reply で実装
          // ここでは「これから返信作るよ」と軽く伝えてもよい
          await replyToLine(replyToken, [{ type: 'text', text: '返信生成を開始します。しばらくお待ちください...' }])

          continue
        } else if (text === 'いいえ') {
          // メッセージ入力を促す（waiting_for_input_textへ）
          await supabase
            .from('line_message_sessions')
            .update({ status: 'waiting_for_input_text' })
            .eq('id', lastSession.id)

          await replyToLine(replyToken, [
            { type: 'text', text: 'どんな内容に対して作成しますか？メッセージを入力してください。' },
          ])

          continue
        } else {
          await replyToLine(replyToken, [
            { type: 'text', text: '「はい」か「いいえ」でお答えください。' },
          ])
          continue
        }
      }

      if (lastSession.status === 'waiting_for_input_text') {
        await supabase
          .from('line_message_sessions')
          .update({
            input_text: text,
            status: 'waiting_for_generated_reply',
          })
          .eq('id', lastSession.id)

        // reply_profiles取得
        const { data: replyProfiles, error: replyProfilesError } = await supabase
          .from('reply_profiles')
          .select('input_text, reply_text')
          .eq('person_id', lastSession.selected_person_id)
          .order('created_at', { ascending: false })
          .limit(10)

        if (replyProfilesError) {
          console.error('Supabase reply_profiles fetch error:', replyProfilesError)
          await replyToLine(replyToken, [{ type: 'text', text: 'システムエラーが発生しました。' }])
          continue
        }

        // OpenAI API呼び出し
        const openaiResponse = await fetch(VERCEL_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            inputText: text,
            replyProfiles: replyProfiles || [],
          }),
        })

        const responseText = await openaiResponse.text()
        console.log('Vercel API raw response:', responseText)

        let openaiResult
        try {
          openaiResult = JSON.parse(responseText)
        } catch (e) {
          console.error('Failed to parse JSON from Vercel API:', e)
          await replyToLine(replyToken, [{ type: 'text', text: '返信生成APIの応答が不正です。' }])
          continue
        }

        const generatedReply = openaiResult.reply || '返信生成に失敗しました。'

        await supabase
          .from('line_message_sessions')
          .update({ generated_reply: generatedReply, status: 'waiting_for_actual_reply_text' })
          .eq('id', lastSession.id)

        // 返信例を表示し、実際に送るメッセージ入力を促す
        await replyToLine(replyToken, [
          { type: 'text', text: `返信例:\n${generatedReply}` },
          { type: 'text', text: '実際に送るメッセージを送ってください。' },
        ])

        continue
      }

      if (lastSession.status === 'waiting_for_generated_reply') {
        // ここに返信生成API呼び出し処理を追加して、返信例を送るだけに最小限修正

        const { data: replyProfiles, error: replyProfilesError } = await supabase
          .from('reply_profiles')
          .select('input_text, reply_text')
          .eq('person_id', lastSession.selected_person_id)
          .order('created_at', { ascending: false })
          .limit(10)

        if (replyProfilesError) {
          console.error('Supabase reply_profiles fetch error:', replyProfilesError)
          await replyToLine(replyToken, [{ type: 'text', text: 'システムエラーが発生しました。' }])
          continue
        }

        // 生成元のテキストをちゃんと取る（waiting_for_input_textの場合と同様に）
        const inputText = lastSession.input_text || lastSession.message_text || ''

        const openaiResponse = await fetch(VERCEL_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            inputText,
            replyProfiles: replyProfiles || [],
          }),
        })

        const responseText = await openaiResponse.text()
        console.log('Vercel API raw response:', responseText)

        let openaiResult
        try {
          openaiResult = JSON.parse(responseText)
        } catch (e) {
          console.error('Failed to parse JSON from Vercel API:', e)
          await replyToLine(replyToken, [{ type: 'text', text: '返信生成APIの応答が不正です。' }])
          continue
        }

        const generatedReply = openaiResult.reply || '返信生成に失敗しました。'

        await supabase
          .from('line_message_sessions')
          .update({ generated_reply: generatedReply, status: 'waiting_for_actual_reply_text' })
          .eq('id', lastSession.id)

        await replyToLine(replyToken, [
          { type: 'text', text: `返信例:\n${generatedReply}` },
          { type: 'text', text: '実際に送るメッセージを送ってください。' },
        ])

        continue
      }

      if (lastSession.status === 'waiting_for_actual_reply_text') {
        // 実際に送るメッセージを受け取ったら、返信例とセットでreply_profilesに保存
        const generatedReply = lastSession.generated_reply || ''
        const inputText = lastSession.input_text || lastSession.message_text || ''

        // reply_profiles保存
        const { error: insertReplyError } = await supabase.from('reply_profiles').insert([
          {
            user_id: userProfile.user_id,
            person_id: lastSession.selected_person_id,
            input_text: inputText,
            reply_text: text,
            created_at: new Date().toISOString(),
          },
        ])

        if (insertReplyError) {
          console.error('Failed to insert reply_profile:', insertReplyError)
          await replyToLine(replyToken, [{ type: 'text', text: '返信ペアの保存に失敗しました。' }])
          continue
        }

        // セッション完了に更新
        await supabase
          .from('line_message_sessions')
          .update({ status: 'completed' })
          .eq('id', lastSession.id)

        await replyToLine(replyToken, [{ type: 'text', text: 'メッセージを保存しました。ありがとうございました！' }])
        continue
      }

      // それ以外はエラーメッセージ
      await replyToLine(replyToken, [
        { type: 'text', text: '申し訳ありませんが、現在その操作はできません。' },
      ])
    }

    res.status(200).send('OK')
  } catch (error) {
    console.error('Unhandled error:', error)
    res.status(500).send('Internal Server Error')
  }
})

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
