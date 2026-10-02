# 边界情况

连续空行：


段落之间的多个空行。

转义字符：\*不是斜体\*、\_不是下划线\_、\\反斜杠。

HTML 实体：&amp; &lt; &gt; &quot; &#39; &nbsp;

原始 HTML 标签（allowHtml 关闭时应转义）：<script>alert(1)</script> 与 <img src=x onerror=alert(1)>

## 特殊标题：emoji 🎉 与符号 @#$%^&*()

## 特殊标题：emoji 🎉 与符号 @#$%^&*()

### 中文标点：，。！？；：「」『』

超长单词：aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

行尾两个空格制造硬换行  
这一行应该在换行之后。

不规范的表格（列数不匹配）：

| A | B | C |
| --- | --- |
| 1 | 2 |
| 3 | 4 | 5 | 6 |

未闭合的代码块：

```
没有结束围栏

嵌套引用：

> 第一层
> > 第二层
> > > 第三层

空标题：

#

只有空格的段落：

   

最后一行（无换行符结尾）
