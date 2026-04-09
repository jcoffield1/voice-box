import type { ConversationMessage } from '@shared/types'
import { Bot, User } from 'lucide-react'
import { renderMarkdown } from '../../utils/markdown'

interface Props {
  message: ConversationMessage
  isStreaming?: boolean
}

export default function ChatMessageBubble({ message, isStreaming }: Props) {
  const isUser = message.role === 'user'

  return (
    <div className={`flex gap-2 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      <div
        className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
          isUser ? 'bg-accent/20' : 'bg-surface-600'
        }`}
      >
        {isUser ? (
          <User className="w-3.5 h-3.5 text-accent" />
        ) : (
          <Bot className="w-3.5 h-3.5 text-zinc-400" />
        )}
      </div>
      <div
        className={`max-w-[85%] rounded-xl px-3 py-2 text-sm leading-relaxed ${
          isUser
            ? 'bg-accent/20 text-zinc-100 rounded-tr-sm whitespace-pre-wrap'
            : 'bg-surface-700 text-zinc-200 rounded-tl-sm'
        } ${isStreaming ? 'after:content-["▋"] after:animate-pulse after:text-accent' : ''}`}
      >
        {isUser ? (
          message.content
        ) : (
          <div
            className="prose-sm"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
          />
        )}
      </div>
    </div>
  )
}
