import random, html
random.seed(1126)

CSS = """
@page { size: 11in 8.5in; margin: 0; }
* { box-sizing: border-box; }
body { margin:0; font-family: 'DejaVu Sans', sans-serif; color:#1f2937; }
.page { width:11in; height:8.5in; padding:0.4in 0.5in; page-break-after: always; position:relative; overflow:hidden; }
.page:last-child { page-break-after:auto; }
h1 { margin:0; font-size:30pt; color:#9a3412; }
h2 { margin:0; font-size:15pt; color:#57534e; font-weight:normal; }
.hdr { display:flex; justify-content:space-between; align-items:flex-end; border-bottom:4px solid #ea580c; padding-bottom:6px; margin-bottom:12px; }
.tag { white-space:nowrap; font-size:13pt; color:#78716c; }
"""

def page(inner): return f'<div class="page">{inner}</div>'
def doc(pages, extra=""): return f"<!doctype html><html><head><meta charset='utf-8'><style>{CSS}{extra}</style></head><body>{''.join(pages)}</body></html>"

# ---------- Four corners ----------
fc_css = """
.grid4 { position:absolute; left:0.5in; right:0.5in; top:1.25in; height:6in; display:grid; grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr; gap:14px; }
.q { border:4px solid; border-radius:18px; display:flex; flex-direction:column; }
.q .t { font-size:26pt; font-weight:bold; padding:10px 16px; border-radius:13px 13px 0 0; }
.q .s { font-size:12pt; padding:4px 16px; color:#57534e; }
.pie-line { margin:6px 16px; font-size:15pt; }
.pie-line span { display:inline-block; border-bottom:2px dashed #a16207; width:4.2in; }
"""
quads = [("Mac &amp; Cheese","#fef9c3","#eab308","#854d0e",""),
         ("Sweet Potato Casserole","#ffedd5","#f97316","#9a3412",""),
         ("Pie","#fce7f3","#ec4899","#9d174d","<div class='pie-line'>What kind? <span></span></div>"),
         ("Honey-Baked / Glazed Ham","#fee2e2","#dc2626","#991b1b","")]
qs = "".join(f"<div class='q' style='border-color:{b}'><div class='t' style='background:{bg};color:{c}'>{t}</div>{x}<div class='s'>Drop your name stamp here.</div></div>" for t,bg,b,c,x in quads)
fc = page(f"<div class='hdr'><div><h1>Four Corners: Thanksgiving</h1><h2>Pick ONE food. Non-turkey division. Stamp your name in its corner.</h2></div><div class='tag'>Warm-up</div></div><div class='grid4'>{qs}</div><div style='position:absolute;left:0.5in;right:0.5in;top:7.5in;text-align:center;font-size:15pt;color:#9a3412'>Keep your stamp <b>inside</b> a box. Your corner decides your next worksheet...</div>")
open("four_corners.html","w").write(doc([fc], fc_css))

# ---------- Pictionary ----------
prompts = ["A turkey escaping the farm","Grandma's cursed casserole","The dog under the table","A turkey debugging its code",
 "Pie cooling on a windowsill","Food coma","The Black Friday line","A parade balloon gone rogue","The kids' table",
 "A leftover-sandwich tower","Uncle asleep during the football game","Cranberry sauce still shaped like the can",
 "A robot carving the turkey","404: Turkey Not Found","A pilgrim on a skateboard","Stretchy pants"]
pc_css = """
.cols { display:grid; grid-template-columns: 3.3in 1fr; gap:16px; height:6.6in; }
.rules { background:#fff7ed; border:3px solid #fdba74; border-radius:14px; padding:10px 14px; font-size:11.5pt; }
.rules ol { padding-left:18px; margin:6px 0; } .rules li { margin-bottom:5px; }
.list { columns:1; font-size:11.5pt; margin-top:8px; }
.list div { padding:2px 0; border-bottom:1px dotted #e7e5e4; }
.list b { display:inline-block; width:24px; color:#c2410c; }
.draw { border:4px dashed #a8a29e; border-radius:16px; display:flex; align-items:flex-start; justify-content:flex-end; padding:10px 14px; color:#a8a29e; font-size:13pt; }
"""
cats = [("Thanksgiving food","pie, gravy boat, a sad salad"),("Family chaos","the kids' table, burnt rolls"),
 ("Computer stuff","a mouse, a bug, the cloud"),("Animals","turkey, dog begging, a cat on the table"),
 ("Black Friday","a huge TV, a long line"),("Wild card","anything (school appropriate)")]
lst = "".join(f"<div><b>{i+1}</b>{c} <span style='color:#a8a29e'>e.g. {e}</span></div>" for i,(c,e) in enumerate(cats))
pc = page(f"""<div class='hdr'><div><h1>Turkey Pictionary</h1><h2>Group board. One drawer at a time; everyone else guesses in board chat.</h2></div><div class='tag'>Group round</div></div>
<div class='cols'><div class='rules'><b>How to play</b><ol>
<li>Drawer: say a <b>category</b> in chat, then think of a thing in it. Don't use the examples!</li>
<li>Draw it in the box. <b>No letters, no numbers.</b></li>
<li>Guess in <b>chat</b>. First correct guess gets a point and draws next.</li>
<li>Drawer: clear your drawing with undo or the eraser before passing.</li>
<li>Score with tally marks next to your name in the corner.</li></ol>
<b>Categories</b><div class='list'>{lst}</div></div>
<div class='draw'>DRAW HERE</div></div>""")
open("pictionary.html","w").write(doc([pc], pc_css))

# ---------- Bingo ----------
pool = [
 "Rename yourself to the longest name you can",
 "Use an emoji in your display name",
 "Undo 25 times as fast as you can",
 "Write a 300-word text box, then resize it",
 "Highlight over a text box",
 "Refresh the page halfway through a stroke",
 "Zoom way out, draw, zoom back in",
 "Wifi off for 10 sec, draw, wifi back on",
 "Open the room on your phone and draw",
 "Open the room in a 2nd tab; draw in both",
 "Set status to Need Help, then clear it",
 "Export your board as a PNG",
 "Put 10 stamps in a perfect circle",
 "Draw a shape, then change its color",
 "Make a shape tiny, then huge",
 "Text box in another language (or emoji)",
 "Type text, undo it, then redo it",
 "Resize chat to smallest, then biggest",
 "Collapse chat, then bring it back",
 "Send a chat message that is only emoji",
 "Send a 3-line chat message",
 "Send a chat message with a link",
 "Try to erase the worksheet itself",
 "Erase just the middle of a long stroke",
 "Draw off the edge of the worksheet",
 "Pan really far away, then find home",
 "Copy and paste something you drew",
 "Select everything, delete, then undo",
 "Change your color: does old ink change?",
 "Browser zoom 200% (Ctrl +), then draw",
 "Shrink the window to half the screen",
 "Close the tab, rejoin with the same name",
 "Join in an incognito window",
 "Draw with the highlighter on top of pen",
 "Paste a paragraph from a website into text",
 "Drag an image file onto the board",
 "Try every shortcut: Ctrl+Z, Ctrl+Y, Del, Esc",
 "Right-click on 5 different things",
 "Double-click on 5 different things",
 "Lasso-select something and drag it",
 "Draw while the class timer is running",
 "Draw the fastest scribble you can",
]
assert len(pool) >= 42
random.shuffle(pool)
# 4 cards x 24 squares = 96 slots; every task appears on >= 2 cards
cards=[]
for k in range(4):
    rot = pool[k*10:] + pool[:k*10]
    picked = rot[:24]; random.shuffle(picked); cards.append(picked)

bg_css = """
.bgrid { display:grid; grid-template-columns:repeat(5,1fr); grid-template-rows:0.5in repeat(5,1fr); gap:6px; height:6.45in; width:7.4in; }
.bh { background:#ea580c; color:white; font-size:24pt; font-weight:bold; display:flex; align-items:center; justify-content:center; border-radius:8px; }
.sq { border:2.5px solid #d6d3d1; border-radius:8px; padding:6px 7px; font-size:10.5pt; line-height:1.2; position:relative; }
.sq .m { position:absolute; bottom:4px; left:6px; right:6px; font-size:8pt; color:#a8a29e; letter-spacing:1px; }
.free { background:#fff7ed; border-color:#fb923c; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; font-weight:bold; color:#9a3412; font-size:13pt; }
.wrap { display:flex; gap:16px; }
.side { flex:1; font-size:11pt; }
.box { border:3px solid #fdba74; background:#fff7ed; border-radius:12px; padding:8px 12px; margin-bottom:10px; }
.box p { margin:4px 0; }
.big { font-size:44pt; font-weight:bold; color:#ea580c; text-align:center; line-height:1; }
"""
def card(letter, tasks):
    cells = "".join(f"<div class='bh'>{c}</div>" for c in "GOBBLE"[:5])
    cells = "".join(f"<div class='bh'>{c}</div>" for c in ["B","U","G","G","Y"])
    it = iter(tasks)
    for i in range(25):
        if i==12: cells += "<div class='sq free'>FREE<br><span style='font-size:9pt;font-weight:normal'>(gobble gobble)</span></div>"
        else: cells += f"<div class='sq'>{html.escape(next(it))}<div class='m'>OK&nbsp;&nbsp;BUG&nbsp;&nbsp;?</div></div>"
    side = f"""<div class='box'><div class='big'>CARD {letter}</div></div>
<div class='box'><b>For each square, circle one:</b>
<p><b>OK</b> = worked like you'd expect</p><p><b>BUG</b> = something weird happened: write a bug report!</p><p><b>?</b> = couldn't figure out how (that's feedback too)</p></div>
<div class='box'><b>Win:</b> 5 in a row = BINGO. Every BUG you report is worth more than a bingo.</div>
<div class='box'><b>Rules</b><p>No scripts or bots. No spam-pasting.</p><p>Stay on <b>your own</b> board.</p><p>"It broke" is not a bug report. Steps are.</p></div>"""
    return page(f"<div class='hdr'><div><h1>Bug Bingo</h1><h2>Break it on purpose. Write down how.</h2></div><div class='tag'>Name: ______________________</div></div><div class='wrap'><div class='bgrid'>{cells}</div><div class='side'>{side}</div></div>")

intro_css = """
.cardpick { display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin:14px 0; }
.cp { border:3px solid #fdba74; border-radius:14px; text-align:center; padding:12px; background:#fff7ed; }
.cp .l { font-size:40pt; font-weight:bold; color:#ea580c; } .cp .r { font-size:14pt; }
.steps { font-size:14pt; line-height:1.5; }
"""
intro = page("""<div class='hdr'><div><h1>Bug Bingo: Start Here</h1><h2>You are QA testers today. Your job: find what's broken before 30 other classrooms do.</h2></div><div class='tag'>Solo round</div></div>
<div class='steps'><b>Find your card</b> by the first letter of your <b>first name</b>, then scroll down to it:</div>
<div class='cardpick'><div class='cp'><div class='l'>A</div><div class='r'>Names A to E</div></div><div class='cp'><div class='l'>B</div><div class='r'>Names F to J</div></div><div class='cp'><div class='l'>C</div><div class='r'>Names K to R</div></div><div class='cp'><div class='l'>D</div><div class='r'>Names S to Z</div></div></div>
<div class='steps'><ol>
<li>Do the squares in any order. Circle <b>OK</b>, <b>BUG</b>, or <b>?</b> on each one.</li>
<li>Every <b>BUG</b> gets a bug report card on the <b>last page</b>.</li>
<li>Hit Bingo? Set your status to <b>Done</b>, then keep hunting.</li>
<li>Found something really broken? Try to make it happen <b>again</b>. A bug you can repeat is gold.</li></ol></div>""")

br_css = """
.reports { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; height:6.6in; }
.rep { border:3px solid #d6d3d1; border-radius:14px; padding:8px 12px; font-size:10.5pt; display:flex; flex-direction:column; }
.rep .n { font-weight:bold; color:#c2410c; font-size:14pt; margin-bottom:2px; }
.f { border-bottom:1.5px solid #d6d3d1; margin-top:4px; padding-bottom:2px; }
.f.tall { flex:1; border:1.5px solid #d6d3d1; border-radius:6px; padding:4px 6px; margin-top:6px; }
.sev { margin-top:6px; font-size:9.5pt; }
"""
def rep(n): return f"""<div class='rep'><div class='n'>Bug #{n}</div>
<div class='f'><b>Square:</b></div><div class='f'><b>Device / browser:</b></div>
<div class='f tall'><b>Steps</b> (1, 2, 3...)</div><div class='f tall' style='flex:0.55'><b>Expected</b></div><div class='f tall' style='flex:0.7'><b>Actually happened</b></div>
<div class='sev'><b>Happens again?</b>&nbsp; Every time / Sometimes / Once</div>
<div class='sev'><b>How bad?</b>&nbsp; Looks weird / Annoying / Broke it</div></div>"""
br = page(f"<div class='hdr'><div><h1>Bug Report Cards</h1><h2>Type in a text box over each section. Someone who wasn't there should be able to make the bug happen.</h2></div><div class='tag'>Need more? Draw your own card.</div></div><div class='reports'>{rep(1)}{rep(2)}{rep(3)}</div>")

open("bug_bingo.html","w").write(doc([intro]+[card(L,t) for L,t in zip("ABCD",cards)]+[br], bg_css+intro_css+br_css))

for L,t in zip("ABCD",cards):
    open(f"card_{L}.html","w").write(doc([card(L,t), br], bg_css+intro_css+br_css))
