function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderInline(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
}

function listTagFor(line) {
  if (/^\s*[-*+]\s+/.test(line)) {
    return 'ul'
  }
  if (/^\s*\d+\.\s+/.test(line)) {
    return 'ol'
  }
  return ''
}

function stripListPrefix(line) {
  return line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
}

export function renderCatalpa(source) {
  const lines = source.split(/\r?\n/)
  const html = []
  let i = 0

  while (i < lines.length) {
    const rawLine = lines[i]
    const line = rawLine.trimEnd()

    if (line.trim() === '') {
      i += 1
      continue
    }

    if (/^```/.test(line.trim())) {
      const language = line.trim().slice(3).trim()
      i += 1
      const codeLines = []
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        codeLines.push(lines[i])
        i += 1
      }
      i += 1
      const escaped = escapeHtml(codeLines.join('\n'))
      const langClass = language ? ` class="language-${language}"` : ''
      html.push(`<pre><code${langClass}>${escaped}</code></pre>`)
      continue
    }

    if (/^#{1,6}\s+/.test(line.trim())) {
      const headingLine = line.trim()
      const level = headingLine.match(/^#{1,6}/)[0].length
      const text = escapeHtml(headingLine.replace(/^#{1,6}\s+/, '').trim())
      html.push(`<h${level}>${renderInline(text)}</h${level}>`)
      i += 1
      continue
    }

    if (/^>\s?/.test(line.trim())) {
      const quoteLines = []
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''))
        i += 1
      }
      const quoteText = quoteLines.map((item) => renderInline(escapeHtml(item))).join('<br />')
      html.push(`<blockquote>${quoteText}</blockquote>`)
      continue
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      html.push('<hr />')
      i += 1
      continue
    }

    const currentListTag = listTagFor(line)
    if (currentListTag) {
      const listItems = []
      while (i < lines.length) {
        const nextTag = listTagFor(lines[i])
        if (nextTag !== currentListTag) {
          break
        }
        const text = escapeHtml(stripListPrefix(lines[i].trim()))
        listItems.push(`<li>${renderInline(text)}</li>`)
        i += 1
      }
      html.push(`<${currentListTag}>${listItems.join('')}</${currentListTag}>`)
      continue
    }

    const paragraphLines = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^#{1,6}\s+/.test(lines[i].trim()) &&
      !/^```/.test(lines[i].trim()) &&
      !/^>\s?/.test(lines[i].trim()) &&
      !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim()) &&
      !listTagFor(lines[i])
    ) {
      paragraphLines.push(lines[i].trim())
      i += 1
    }
    const paragraphText = escapeHtml(paragraphLines.join(' '))
    html.push(`<p>${renderInline(paragraphText)}</p>`)
  }

  return html.join('\n')
}
