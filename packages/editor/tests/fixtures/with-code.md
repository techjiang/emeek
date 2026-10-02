# 代码块

JavaScript：

```javascript
// 计算斐波那契
function fib(n) {
  if (n <= 1) return n;
  return fib(n - 1) + fib(n - 2);
}
const r = fib(10);
console.log(`结果：${r}`);
```

Python：

```python
def quicksort(items):
    if len(items) <= 1:
        return items
    pivot = items[len(items) // 2]
    return quicksort([x for x in items if x < pivot]) + [pivot]
```

没有语言标注的块：

```
plain text  <tag> & "quoted" 中文
  缩进保留
```

未知语言：

```notalanguage
this should render as plain text
```

Shell 与 JSON：

```bash
pnpm install && pnpm test
```

```json
{ "name": "emeeek", "nested": { "a": [1, 2, 3] } }
```
