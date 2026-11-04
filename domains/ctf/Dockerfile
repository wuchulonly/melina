# syntax=docker/dockerfile:1
ARG BASE
FROM ${BASE} AS melina-base
FROM --platform=linux/amd64 docker.io/kalilinux/kali-rolling@sha256:ed99295a386abde2fb31e01a441b7c2800d9bcf19a20028b77d642c3ef068363

ARG DEBIAN_FRONTEND=noninteractive
ARG NUCLEI_VERSION=3.7.1
ARG RIPGREP_VERSION=15.1.0
ARG FD_VERSION=10.4.2

RUN apt-get update && apt-get install -y --no-install-recommends \
    kali-linux-core build-essential pkg-config python3-dev default-libmysqlclient-dev python3 python3-pip python3-venv sudo bash git curl wget ca-certificates unzip zip \
    bsdextrautils npm jq iputils-ping sshpass ncat rlwrap time traceroute \
    bloodyad coercer enum4linux-ng pwncat chisel-common-binaries \
    dirsearch yq krb5-user gitleaks naabu nikto netexec adb chromium \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

COPY analysis-requirements.txt provenance.json /opt/ctf/
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r /opt/ctf/analysis-requirements.txt \
    && npm install -g @playwright/cli@0.1.19 \
    && curl -fsSL https://aliyuncli.alicdn.com/install.sh -o /tmp/install-aliyun.sh \
    && bash /tmp/install-aliyun.sh && rm /tmp/install-aliyun.sh

RUN mkdir -p /opt/ctf/bin /opt/ctf/share \
    && wget -q "https://github.com/projectdiscovery/nuclei/releases/download/v${NUCLEI_VERSION}/nuclei_${NUCLEI_VERSION}_linux_amd64.zip" -O /tmp/nuclei.zip \
    && unzip -q /tmp/nuclei.zip nuclei -d /opt/ctf/bin \
    && rm /tmp/nuclei.zip \
    && git clone --depth 1 https://github.com/projectdiscovery/nuclei-templates.git /opt/ctf/share/nuclei-templates \
    && git clone --depth 1 https://github.com/vulhub/vulhub.git /opt/ctf/share/vulhub \
    && rm -rf /opt/ctf/share/nuclei-templates/.git /opt/ctf/share/vulhub/.git

RUN wget -q "https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/ripgrep_${RIPGREP_VERSION}-1_amd64.deb" -O /tmp/ripgrep.deb \
    && wget -q "https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/fd_${FD_VERSION}_amd64.deb" -O /tmp/fd.deb \
    && apt-get install -y /tmp/ripgrep.deb /tmp/fd.deb \
    && rm /tmp/ripgrep.deb /tmp/fd.deb \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

COPY nuclei.yaml playwright.json python-environments.json /opt/ctf/
COPY nuclei-custom/ /opt/ctf/share/nuclei-custom/
COPY --chmod=755 nuclei /usr/local/bin/nuclei

COPY --chmod=755 install-toolchain.sh /opt/ctf/install-toolchain.sh
COPY jdwp-shellifier.patch /opt/ctf/jdwp-shellifier.patch
RUN /opt/ctf/install-toolchain.sh
RUN rm -f /opt/ctf/share/wordlists/web-small.txt
COPY --chmod=644 wordlists/web-small.txt /opt/ctf/share/wordlists/web-small.txt
COPY offline-python/ /opt/ctf/share/python-offline/
COPY --chmod=755 install-offline-python.sh /opt/ctf/install-offline-python.sh
RUN bash /opt/ctf/install-offline-python.sh
COPY --chmod=755 ctf-python /usr/local/bin/ctf-python
RUN chmod 0755 /usr/local/bin/ctf-python
COPY --chmod=755 check-offline-python.sh /opt/ctf/check-offline-python.sh
COPY --chmod=755 jdwp-shellifier ctf-wordlists /usr/local/bin/
RUN chmod 0755 /usr/local/bin/jdwp-shellifier /usr/local/bin/ctf-wordlists
COPY --chmod=755 hashcat /usr/local/bin/hashcat
COPY --chmod=755 analyzeHeadless /usr/local/bin/analyzeHeadless
COPY --chmod=755 dirsearch /usr/bin/dirsearch
COPY --chmod=755 check-reversing.sh /opt/ctf/check-reversing.sh
COPY check-protocols.py /opt/ctf/check-protocols.py
COPY capabilities.json check-capabilities.py /opt/ctf/
COPY --chmod=755 ctf-check /usr/local/bin/ctf-check

COPY jwt-tool.patch /opt/ctf/
COPY --chmod=755 install-supplement.sh /opt/ctf/install-supplement.sh
RUN /opt/ctf/install-supplement.sh
COPY --chmod=755 jwt_tool /usr/local/bin/
COPY check-supplement.py /opt/ctf/check-supplement.py

COPY toolchain.lock.json update-tools.py /opt/ctf/
RUN /usr/bin/python3 /opt/ctf/update-tools.py

COPY --from=melina-base /usr/bin/tini /usr/bin/tini
COPY reference/ /melina/ctf/
COPY profile.sh /etc/profile.d/ctf.sh
RUN git config --system user.name Melina \
    && git config --system user.email melina@localhost \
    && git config --system init.defaultBranch main \
    && git config --system advice.detachedHead false \
    && git config --system --add safe.directory '*' \
    && mkdir -p /workspace /melina/artifacts /melina/materials /melina/logs \
    && install -d -m 1777 /tmp /var/tmp

ENV PATH="/opt/venv/bin:/usr/local/sbin:/usr/local/bin:/opt/ctf/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    VIRTUAL_ENV=/opt/venv LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=Etc/UTC \
    PAGER=cat GIT_PAGER=cat PIP_ROOT_USER_ACTION=ignore PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 NO_UPDATE_NOTIFIER=1 CTF_REFERENCE=/melina/ctf/README.md \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ctf/share/playwright GRADIO_ALLOW_FLAGGING=never NMAP_UNPRIVILEGED=1
USER root
WORKDIR /workspace
RUN ctf-check
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
