FROM dovecot/dovecot:2.3.21

COPY dovecot.conf /etc/dovecot/dovecot.conf
COPY users /etc/dovecot/users
COPY seed-mail.sh /usr/local/bin/seed-mail.sh

RUN chmod +x /usr/local/bin/seed-mail.sh \
 && chown root:dovecot /etc/dovecot/users \
 && chmod 640 /etc/dovecot/users \
 && /usr/local/bin/seed-mail.sh 500

EXPOSE 993
