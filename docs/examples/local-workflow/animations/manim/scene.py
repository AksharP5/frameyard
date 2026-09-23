from manim import *


class Diagram(Scene):
    def construct(self):
        self.camera.background_color = "#111827"
        title = Text("Manim", font="Inter", font_size=64).to_edge(UP)
        equation = MathTex(r"a^2 + b^2 = c^2", font_size=64).to_edge(DOWN)
        square = Square(side_length=2, color="#67e8f9").set_fill("#67e8f9", opacity=0.25)
        self.add(title)
        self.play(Create(square), Write(equation), run_time=1)
        self.play(square.animate.rotate(PI / 4).shift(RIGHT * 2), run_time=1)
        self.wait(1)
