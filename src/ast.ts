// parse a single path portion

import { MinimatchOptions, MMRegExp } from './index.js'
import { parseClass } from './brace-expressions.js'
import { unescape } from './unescape.js'

// classes [] are handled by the parseClass method
// for positive extglobs, we sub-parse the contents, and combine,
// with the appropriate regexp close.
// for negative extglobs, we sub-parse the contents, but then
// have to include the rest of the pattern, then the parent, etc.,
// as the thing that cannot be because RegExp negative lookaheads
// are different from globs.
//
// So for example:
// a@(i|w!(x|y)z|j)b => ^a(i|w((!?(x|y)zb).*)z|j)b$
//   1   2 3   4 5 6      1   2    3   46      5 6
//
// Assembling the extglob requires not just the negated patterns themselves,
// but also anything following the negative patterns up to the boundary
// of the current pattern, plus anything following in the parent pattern.
//
//
// So, first, we parse the string into an AST of extglobs, without turning
// anything into regexps yet.
//
// ['a', {@ [['i'], ['w', {!['x', 'y']}, 'z'], ['j']]}, 'b']
//
// Then, for all the negative extglobs, we append whatever comes after in
// each parent as their tail
//
// ['a', {@ [['i'], ['w', {!['x', 'y'], 'z', 'b'}, 'z'], ['j']]}, 'b']
//
// Lastly, we turn each of these pieces into a regexp, and join
//
//                                 v----- .* because there's more following,
//                                 v    v  otherwise, .+ because it must be
//                                 v    v  *something* there.
// ['^a', {@ ['i', 'w(?:(!?(?:x|y).*zb$).*)z', 'j' ]}, 'b$']
//   copy what follows into here--^^^^^
// ['^a', '(?:i|w(?:(?!(?:x|y).*zb$).*)z|j)', 'b$']
// ['^a(?:i|w(?:(?!(?:x|y).*zb$).*)z|j)b$']

export type ExtglobType = '!' | '?' | '+' | '*' | '@'
const types = new Set<ExtglobType>(['!', '?', '+', '*', '@'])
const isExtglobType = (c: string): c is ExtglobType =>
  types.has(c as ExtglobType)

// Patterns that get prepended to bind to the start of either the
// entire string, or just a single path portion, to prevent dots
// and/or traversal patterns, when needed.
// Exts don't need the ^ or / bit, because the root binds that already.
const startNoTraversal = '(?!\\.\\.?(?:$|/))'
const startNoDot = '(?!\\.)'

// characters that indicate a start of pattern needs the "no dots" bit,
// because a dot *might* be matched. ( is not in the list, because in
// the case of a child extglob, it will handle the prevention itself.
const addPatternStart = new Set(['[', '.'])
// cases where traversal is A-OK, no dot prevention needed
const justDots = new Set(['..', '.'])
const reSpecials = new Set('().*{}+?[]^$\\!')
const regExpEscape = (s: string) =>
  s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')

// any single thing other than /
const qmark = '[^/]'

// * => any number of characters
const star = qmark + '*?'
// use + when we need to ensure that *something* matches, because the * is
// the only thing in the path portion.
const starNoEmpty = qmark + '+?'

// remove the \ chars that we added if we end up doing a nonmagic compare
// const deslash = (s: string) => s.replace(/\\(.)/g, '$1')

export class AST {
  type: ExtglobType | null
  readonly #root: AST

  #hasMagic?: boolean
  #uflag: boolean = false
  #parts: (string | AST)[] = []
  readonly #parent?: AST
  readonly #parentIndex: number
  #negs: AST[]
  #filledNegs: boolean = false
  #options: MinimatchOptions
  #toString?: string
  // set to true if it's an extglob with no children
  // (which really means one child of '')
  #emptyExt: boolean = false

  constructor(
    type: ExtglobType | null,
    parent?: AST,
    options: MinimatchOptions = {}
  ) {
    this.type = type
    // extglobs are inherently magical
    if (type) this.#hasMagic = true
    this.#parent = parent
    this.#root = this.#parent ? this.#parent.#root : this
    this.#options = this.#root === this ? options : this.#root.#options
    this.#negs = this.#root === this ? [] : this.#root.#negs
    if (type === '!' && !this.#root.#filledNegs) this.#negs.push(this)
    this.#parentIndex = this.#parent ? this.#parent.#parts.length : 0
  }

  get hasMagic(): boolean | undefined {
    /* c8 ignore start */
    if (this.#hasMagic !== undefined) return this.#hasMagic
    /* c8 ignore stop */
    for (const p of this.#parts) {
      if (typeof p === 'string') continue
      if (p.type || p.hasMagic) return (this.#hasMagic = true)
    }
    // note: will be undefined until we generate the regexp src and find out
    return this.#hasMagic
  }

  // reconstructs the pattern
  toString(): string {
    if (this.#toString !== undefined) return this.#toString
    if (!this.type) {
      return (this.#toString = this.#parts.map(p => String(p)).join(''))
    } else {
      return (this.#toString =
        this.type + '(' + this.#parts.map(p => String(p)).join('|') + ')')
    }
  }

  #fillNegs() {
    /* c8 ignore start */
    if (this !== this.#root) throw new Error('should only call on root')
    if (this.#filledNegs) return this
    /* c8 ignore stop */

    // call toString() once to fill this out
    this.toString()
    this.#filledNegs = true
    let n: AST | undefined
    while ((n = this.#negs.pop())) {
      if (n.type !== '!') continue
      // walk up the tree, appending everthing that comes AFTER parentIndex
      let p: AST | undefined = n
      let pp = p.#parent
      while (pp) {
        for (
          let i = p.#parentIndex + 1;
          !pp.type && i < pp.#parts.length;
          i++
        ) {
          for (const part of n.#parts) {
            /* c8 ignore start */
            if (typeof part === 'string') {
              throw new Error('string part in extglob AST??')
            }
            /* c8 ignore stop */
            part.copyIn(pp.#parts[i])
          }
        }
        p = pp
        pp = p.#parent
      }
    }
    return this
  }

  push(...parts: (string | AST)[]) {
    for (const p of parts) {
      if (p === '') continue
      /* c8 ignore start */
      if (typeof p !== 'string' && !(p instanceof AST && p.#parent === this)) {
        throw new Error('invalid part: ' + p)
      }
      /* c8 ignore stop */
      this.#parts.push(p)
    }
  }

  toJSON() {
    const ret: any[] =
      this.type === null
        ? this.#parts.slice().map(p => (typeof p === 'string' ? p : p.toJSON()))
        : [this.type, ...this.#parts.map(p => (p as AST).toJSON())]
    if (this.isStart() && !this.type) ret.unshift([])
    if (
      this.isEnd() &&
      (this === this.#root ||
        (this.#root.#filledNegs && this.#parent?.type === '!'))
    ) {
      ret.push({})
    }
    return ret
  }

  isStart(): boolean {
    if (this.#root === this) return true
    // if (this.type) return !!this.#parent?.isStart()
    if (!this.#parent?.isStart()) return false
    if (this.#parentIndex === 0) return true
    // if everything AHEAD of this is a negation, then it's still the "start"
    const p = this.#parent
    for (let i = 0; i < this.#parentIndex; i++) {
      const pp = p.#parts[i]
      if (!(pp instanceof AST && pp.type === '!')) {
        return false
      }
    }
    return true
  }

  isEnd(): boolean {
    if (this.#root === this) return true
    if (this.#parent?.type === '!') return true
    if (!this.#parent?.isEnd()) return false
    if (!this.type) return this.#parent?.isEnd()
    // if not root, it'll always have a parent
    /* c8 ignore start */
    const pl = this.#parent ? this.#parent.#parts.length : 0
    /* c8 ignore stop */
    return this.#parentIndex === pl - 1
  }

  copyIn(part: AST | string) {
    if (typeof part === 'string') this.push(part)
    else this.push(part.clone(this))
  }

  clone(parent: AST) {
    const c = new AST(this.type, parent)
    for (const p of this.#parts) {
      c.copyIn(p)
    }
    return c
  }

  static #parseAST(
    str: string,
    ast: AST,
    pos: number,
    opt: MinimatchOptions
  ): number {
    let escaping = false
    let inBrace = false
    let braceStart = -1
    let braceNeg = false
    if (ast.type === null) {
      // outside of a extglob, append until we find a start
      let i = pos
      let acc = ''
      while (i < str.length) {
        const c = str.charAt(i++)
        // still accumulate escapes at this point, but we do ignore
        // starts that are escaped
        if (escaping || c === '\\') {
          escaping = !escaping
          acc += c
          continue
        }

        if (inBrace) {
          if (i === braceStart + 1) {
            if (c === '^' || c === '!') {
              braceNeg = true
            }
          } else if (c === ']' && !(i === braceStart + 2 && braceNeg)) {
            inBrace = false
          }
          acc += c
          continue
        } else if (c === '[') {
          inBrace = true
          braceStart = i
          braceNeg = false
          acc += c
          continue
        }

        if (!opt.noext && isExtglobType(c) && str.charAt(i) === '(') {
          ast.push(acc)
          acc = ''
          const ext = new AST(c, ast)
          i = AST.#parseAST(str, ext, i, opt)
          ast.push(ext)
          continue
        }
        acc += c
      }
      ast.push(acc)
      return i
    }

    // some kind of extglob, pos is at the (
    // find the next | or )
    let i = pos + 1
    let part = new AST(null, ast)
    const parts: AST[] = []
    let acc = ''
    while (i < str.length) {
      const c = str.charAt(i++)
      // still accumulate escapes at this point, but we do ignore
      // starts that are escaped
      if (escaping || c === '\\') {
        escaping = !escaping
        acc += c
        continue
      }

      if (inBrace) {
        if (i === braceStart + 1) {
          if (c === '^' || c === '!') {
            braceNeg = true
          }
        } else if (c === ']' && !(i === braceStart + 2 && braceNeg)) {
          inBrace = false
        }
        acc += c
        continue
      } else if (c === '[') {
        inBrace = true
        braceStart = i
        braceNeg = false
        acc += c
        continue
      }

      if (isExtglobType(c) && str.charAt(i) === '(') {
        part.push(acc)
        acc = ''
        const ext = new AST(c, part)
        part.push(ext)
        i = AST.#parseAST(str, ext, i, opt)
        continue
      }
      if (c === '|') {
        part.push(acc)
        acc = ''
        parts.push(part)
        part = new AST(null, ast)
        continue
      }
      if (c === ')') {
        if (acc === '' && ast.#parts.length === 0) {
          ast.#emptyExt = true
        }
        part.push(acc)
        acc = ''
        ast.push(...parts, part)
        return i
      }
      acc += c
    }

    // unfinished extglob
    // if we got here, it was a malformed extglob! not an extglob, but
    // maybe something else in there.
    ast.type = null
    ast.#hasMagic = undefined
    ast.#parts = [str.substring(pos - 1)]
    return i
  }

  static fromGlob(pattern: string, options: MinimatchOptions = {}) {
    const ast = new AST(null, undefined, options)
    AST.#parseAST(pattern, ast, 0, options)
    return ast
  }

  // returns the regular expression if there's magic, or the unescaped
  // string if not.
  toMMPattern(): MMRegExp | string {
    // should only be called on root
    /* c8 ignore start */
    if (this !== this.#root) return this.#root.toMMPattern()
    /* c8 ignore stop */
    const glob = this.toString()
    const [re, body, hasMagic, uflag] = this.toRegExpSource()
    // if we're in nocase mode, and not nocaseMagicOnly, then we do
    // still need a regular expression if we have to case-insensitively
    // match capital/lowercase characters.
    const anyMagic =
      hasMagic ||
      this.#hasMagic ||
      (this.#options.nocase &&
        !this.#options.nocaseMagicOnly &&
        glob.toUpperCase() !== glob.toLowerCase())
    if (!anyMagic) {
      return body
    }

    const flags = (this.#options.nocase ? 'i' : '') + (uflag ? 'u' : '')
    return Object.assign(new RegExp(`^${re}$`, flags), {
      _src: re,
      _glob: glob,
    })
  }

  // returns the string match, the regexp source, whether there's magic
  // in the regexp (so a regular expression is required) and whether or
  // not the uflag is needed for the regular expression (for posix classes)
  // TODO: instead of injecting the start/end at this point, just return
  // the BODY of the regexp, along with the start/end portions suitable
  // for binding the start/end in either a joined full-path makeRe context
  // (where we bind to (^|/), or a standalone matchPart context (where
  // we bind to ^, and not /).  Otherwise slashes get duped!
  //
  // In part-matching mode, the start is:
  // - if not isStart: nothing
  // - if traversal possible, but not allowed: ^(?!\.\.?$)
  // - if dots allowed or not possible: ^
  // - if dots possible and not allowed: ^(?!\.)
  // end is:
  // - if not isEnd(): nothing
  // - else: $
  //
  // In full-path matching mode, we put the slash at the START of the
  // pattern, so start is:
  // - if first pattern: same as part-matching mode
  // - if not isStart(): nothing
  // - if traversal possible, but not allowed: /(?!\.\.?(?:$|/))
  // - if dots allowed or not possible: /
  // - if dots possible and not allowed: /(?!\.)
  // end is:
  // - if last pattern, same as part-matching mode
  // - else nothing
  //
  // Always put the (?:$|/) on negated tails, though, because that has to be
  // there to bind the end of the negated pattern portion, and it's easier to
  // just stick it in now rather than try to inject it later in the middle of
  // the pattern.
  //
  // We can just always return the same end, and leave it up to the caller
  // to know whether it's going to be used joined or in parts.
  // And, if the start is adjusted slightly, can do the same there:
  // - if not isStart: nothing
  // - if traversal possible, but not allowed: (?:/|^)(?!\.\.?$)
  // - if dots allowed or not possible: (?:/|^)
  // - if dots possible and not allowed: (?:/|^)(?!\.)
  //
  // But it's better to have a simpler binding without a conditional, for
  // performance, so probably better to return both start options.
  //
  // Then the caller just ignores the end if it's not the first pattern,
  // and the start always gets applied.
  //
  // But that's always going to be $ if it's the ending pattern, or nothing,
  // so the caller can just attach $ at the end of the pattern when building.
  //
  // So the todo is:
  // - better detect what kind of start is needed
  // - return both flavors of starting pattern
  // - attach $ at the end of the pattern when creating the actual RegExp
  //
  // Ah, but wait, no, that all only applies to the root when the first pattern
  // is not an extglob. If the first pattern IS an extglob, then we need all
  // that dot prevention biz to live in the extglob portions, because eg
  // +(*|.x*) can match .xy but not .yx.
  //
  // So, return the two flavors if it's #root and the first child is not an
  // AST, otherwise leave it to the child AST to handle it, and there,
  // use the (?:^|/) style of start binding.
  //
  // Even simplified further:
  // - Since the start for a join is eg /(?!\.) and the start for a part
  // is ^(?!\.), we can just prepend (?!\.) to the pattern (either root
  // or start or whatever) and prepend ^ or / at the Regexp construction.
  toRegExpSource(): [
    re: string,
    body: string,
    hasMagic: boolean,
    uflag: boolean
  ] {
    if (this.#root === this) this.#fillNegs()
    if (!this.type) {
      const noEmpty = this.isStart() && this.isEnd()
      const src = this.#parts
        .map(p => {
          const [re, _, hasMagic, uflag] =
            typeof p === 'string'
              ? AST.#parseGlob(p, this.#hasMagic, noEmpty)
              : p.toRegExpSource()
          this.#hasMagic = this.#hasMagic || hasMagic
          this.#uflag = this.#uflag || uflag
          return re
        })
        .join('')

      let start = ''
      if (this.isStart()) {
        if (typeof this.#parts[0] === 'string') {
          // this is the string that will match the start of the pattern,
          // so we need to protect against dots and such.

          // '.' and '..' cannot match unless the pattern is that exactly,
          // even if it starts with . or dot:true is set.
          const dotTravAllowed =
            this.#parts.length === 1 && justDots.has(this.#parts[0])
          if (!dotTravAllowed) {
            const aps = addPatternStart
            // check if we have a possibility of matching . or ..,
            // and prevent that.
            const needNoTrav =
              // dots are allowed, and the pattern starts with [ or .
              (this.#options.dot && aps.has(src.charAt(0))) ||
              // the pattern starts with \., and then [ or .
              (src.startsWith('\\.') && aps.has(src.charAt(2))) ||
              // the pattern starts with \.\., and then [ or .
              (src.startsWith('\\.\\.') && aps.has(src.charAt(4)))
            // no need to prevent dots if it can't match a dot, or if a
            // sub-pattern will be preventing it anyway.
            const needNoDot = !this.#options.dot && aps.has(src.charAt(0))

            start = needNoTrav ? startNoTraversal : needNoDot ? startNoDot : ''
          }
        }
      }

      // append the "end of path portion" pattern to negation tails
      let end = ''
      if (
        this.isEnd() &&
        this.#root.#filledNegs &&
        this.#parent?.type === '!'
      ) {
        end = '(?:$|\\/)'
      }
      const final = start + src + end
      return [
        final,
        unescape(src),
        (this.#hasMagic = !!this.#hasMagic),
        this.#uflag,
      ]
    }

    // some kind of extglob
    const start = this.type === '!' ? '(?:(?!(?:' : '(?:'
    const body = this.#parts
      .map(p => {
        // extglob ASTs should only contain parent ASTs
        /* c8 ignore start */
        if (typeof p === 'string') {
          throw new Error('string type in extglob ast??')
        }
        /* c8 ignore stop */
        // can ignore hasMagic, because extglobs are already always magic
        const [re, _, _hasMagic, uflag] = p.toRegExpSource()
        this.#uflag = this.#uflag || uflag
        return re
      })
      .filter(p => !(this.isStart() && this.isEnd()) || !!p)
      .join('|')
    if (this.isStart() && this.isEnd() && !body && this.type !== '!') {
      // invalid extglob, has to at least be *something* present, if it's
      // the entire path portion.
      const s = this.toString()
      this.#parts = [s]
      this.type = null
      this.#hasMagic = undefined
      return [s, unescape(this.toString()), false, false]
    }
    // an empty !() is exactly equivalent to a starNoEmpty
    let final = ''
    if (this.type === '!' && this.#emptyExt) {
      final =
        (this.isStart() && !this.#options.dot ? startNoDot : '') + starNoEmpty
    } else {
      const close =
        this.type === '!'
          ? // !() must match something,but !(x) can match ''
            '))' +
            (this.isStart() && !this.#options.dot ? startNoDot : '') +
            star +
            ')'
          : this.type === '@'
          ? ')'
          : `)${this.type}`
      final = start + body + close
    }
    return [
      final,
      unescape(body),
      (this.#hasMagic = !!this.#hasMagic),
      this.#uflag,
    ]
  }

  static #parseGlob(
    glob: string,
    hasMagic: boolean | undefined,
    noEmpty: boolean = false
  ): [re: string, body: string, hasMagic: boolean, uflag: boolean] {
    let escaping = false
    let re = ''
    let uflag = false
    for (let i = 0; i < glob.length; i++) {
      const c = glob.charAt(i)
      if (escaping) {
        escaping = false
        re += (reSpecials.has(c) ? '\\' : '') + c
        continue
      }
      if (c === '\\') {
        if (i === glob.length - 1) {
          re += '\\\\'
        } else {
          escaping = true
        }
        continue
      }
      if (c === '[') {
        const [src, needUflag, consumed, magic] = parseClass(glob, i)
        if (consumed) {
          re += src
          uflag = uflag || needUflag
          i += consumed - 1
          hasMagic = hasMagic || magic
          continue
        }
      }
      if (c === '*') {
        if (noEmpty && glob === '*') re += starNoEmpty
        else re += star
        hasMagic = true
        continue
      }
      if (c === '?') {
        re += qmark
        hasMagic = true
        continue
      }
      re += regExpEscape(c)
    }
    return [re, unescape(glob), !!hasMagic, uflag]
  }
}
