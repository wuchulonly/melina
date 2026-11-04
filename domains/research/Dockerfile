# research 领域（spec §11）：调研、写报告、数学证明。Python 数据分析库、LaTeX（含中文）、pandoc、Lean 4、抓网页的工具。
# 从基础镜像构建：pnpm images 传 BASE=localhost/melina-base:<标签>。
ARG BASE
FROM ${BASE}

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      pandoc latexmk lmodern biber \
      texlive-latex-base texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended \
      texlive-science texlive-pictures texlive-xetex texlive-luatex texlive-bibtex-extra \
      texlive-lang-chinese texlive-lang-cjk fonts-noto-cjk \
      graphviz poppler-utils librsvg2-bin w3m lynx \
      build-essential python3-dev \
 && rm -rf /var/lib/apt/lists/*

# 数据分析、符号计算、抓网页、读 PDF 和表格的库，装进 /opt/venv
RUN pip install --no-cache-dir \
      numpy pandas scipy matplotlib seaborn sympy scikit-learn statsmodels networkx \
      requests httpx beautifulsoup4 lxml html5lib trafilatura \
      pypdf pdfplumber openpyxl tabulate tqdm

# Lean 4：elan 装 stable 工具链；Mathlib 这类依赖按项目用 lake 取
ENV ELAN_HOME=/usr/local/elan \
    PATH=/usr/local/elan/bin:$PATH
RUN set -eux; \
    curl -fsSL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -o /tmp/elan-init.sh; \
    sh /tmp/elan-init.sh -y --no-modify-path --default-toolchain stable; \
    rm -f /tmp/elan-init.sh; \
    lean --version; lake --version
