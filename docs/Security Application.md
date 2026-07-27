# Security Application

> Converted from `Security Application.pdf` (C-Bus Security Application protocol documentation).


<!-- page 1 -->

 
 
 
 
 
 
 
 
C-Bus Application Messages & Behaviour 
Chapter 5 – Security 
 
Document Number: CBUS-APP/05 
Issue: 4.3  
Date: 20 March 2007  
 
 
 
 
 
 
 
 
Comments on this document should be addressed to: 
    Engineering Manager  
    Clipsal Integrated Systems 
    PO Box 103 Hindmarsh 
    South Australia 5007 
 

<!-- page 2 -->

Clipsal Australia Pty Ltd  Document: CBUS-APP/05 
ABN 27 007 873 529  Issue:  
   Date:  
 
C-Bus Security Application 
4.3 
20 March 2007 
 Copyright © 2003 - 2008 Clipsal Integrated Systems Page 2 of 24 
TABLE OF CONTENTS 
5 Security Application ........................................................................................................3  
5.1 Application ID.........................................................................................................3  
5.2 Description.............................................................................................................3  
5.3 Document Convention ...........................................................................................3 
5.4 Message Structure.................................................................................................3  
5.4.1 Commands...............................................................................................4  
5.4.2 Message Type Code................................................................................5  
5.5 Defined Commands ...............................................................................................5 
5.5.1 Security System Status Messages ..........................................................5  
5.5.2 Security System Control Messages.......................................................18  
5.6 Message Priority ..................................................................................................22 
5.7 Internetwork Routing............................................................................................22  
5.8 Application Behaviour ..........................................................................................22 
5.8.1 Concatenated Commands .....................................................................22 
5.8.2 State.......................................................................................................23  
5.9 Status Reporting ..................................................................................................23 
5.10 Limitations............................................................................................................23  
5.11 Examples .............................................................................................................23 
5.11.1 Security System Emits “Alarm On” ........................................................23 
5.11.2 Security System Reports “Zone 3 Unsealed”.........................................23 
5.11.3 Security System Issues a “Zone Name” ................................................23 
5.11.4 Device Requests Security System to Arm .............................................24 
5.12 Appendix..............................................................................................................24  
5.12.1 Handling of Disarming Under Duress ....................................................24  
5.12.2 Disarming a Security System via C-Bus ................................................24 
 
 

<!-- page 3 -->

Clipsal Australia Pty Ltd  Document: CBUS-APP/05 
ABN 27 007 873 529  Issue:  
   Date:  
 
C-Bus Security Application 
4.3 
20 March 2007 
5 SECURITY APPLICATION 
5.1 Application ID 
$D0 
5.2 Description 
The Security Application is used to control and monitor a security system.  
 Copyright © 2003 - 2008 Clipsal Integrated Systems Page 3 of 24 
A security system usually makes use of proprietary devices such as sensors, keypads, 
and a monitor panel, but can also respond to C-Bus messages and announce status 
onto C-Bus for other devices to use if they desire. Except where indicated a security 
system should generate and respond to the commands detailed in this document. 
5.3 Document Convention 
Numbers are shown in decimal (base ten) with no other special prefixes or indications. 
Binary numbers (base 2) are shown with the prefix %. 
Hexadecimal numbers (base 16) are shown with the prefix $. 
Example: 157 = %10011101 = $9D 
5.4 Message Structure 
C-Bus messages can be up to 64 bytes long1, though in practice most Security 
Application are 2 bytes long. Security Application messages have the form: 
Command Arguments
Byte 0
Increasing  byte numbers
 
The number of arguments is variable, and is dependent on the command. 
The command byte is broken into bit-fields to support encoding of a command and the 
number of bytes following as parameters. There are two possible codings, to support a 
large number of commands with short arguments, and a small number of commands 
with long arguments. 
                                                 
1 Due to a limitation in the C-Bus PC interface, the Application Data of a single message cannot 
be longer than 14 bytes. 

<!-- page 4 -->

Clipsal Australia Pty Ltd  Document: CBUS-APP/05 
ABN 27 007 873 529  Issue:  
   Date:  
 
C-Bus Security Application 
4.3 
20 March 2007 
The short argument command form is: 
 Copyright © 2003 - 2008 Clipsal Integrated Systems Page 4 of 24 
0 C C C C L L L
70 bit
 
The long argument command form is: 
1 C C L L L L L
70 bit
 
Where “C” represents a bit of a command, and “L” represents a bit of the length. 
This command format provides compatibility with the C-Bus lighting application, and is 
therefore suitable for backward compatibility with older devices and interoperability with 
lighting units. 
The first parameter of all commands is a Message Type Code. 
5.4.1 Commands 
The following commands are supported: 
 Short argument form (binary): 
  %0000 = OFF 
  %1111 = ON 
  %0001 = EVENT 2
  All others reserved. 
The length field reflects the number of arguments. 
 Long argument form (binary): 
  %00 = OFF 
  %11 = ON 
  %01 = EVENT 
  All others reserved. 
The length field reflects the number of arguments. 
                                                 
2 This message form is compatible with a C-Bus Lighting Application TERMINATE RAMP 
command. 

<!-- page 5 -->

Clipsal Australia Pty Ltd  Document: CBUS-APP/05 
ABN 27 007 873 529  Issue:  
   Date:  
 
C-Bus Security Application 
4.3 
20 March 2007 
 Copyright © 2003 - 2008 Clipsal Integrated Systems Page 5 of 24 
5.4.2 Message Type Code 
A C-Bus Security Application Message Type Code3 defines the type of information 
being transmitted into the C-Bus network. 
The following convention is used: 
 Message Type Code: 
  Size:   8-bit byte 
  Range:  $00 .. $FF 
  Special Cases: $00 and $FF are reserved for future expansion 
  Usage:  $01 .. $7F used for sensor zones (reserved for future 
expansion) 
     $80 .. $FE used for security controller 
5.5 Defined Commands 
All commands provide a degree of compatibility with C-Bus lighting application 
commands. The command is followed by a Message Type Code, and then any 
additional arguments. The length field encodes the number of argument bytes which 
follow and apply to that command, including the Message Type Code. 
 
All messages listed are mandatory for C-Bus security systems, unless explicitly 
stated otherwise. Deviation from these messages will cause C-Bus devices to be 
incompatible. Consult Clipsal Integrated Systems before deviating from these 
messages. 
 
5.5.1 Security System Status Messages 
Security System Status Messages are emitted by a security control panel in response 
to events determined by the panel. They are always sent to the Security Application 
Address as a SAL message.  
                                                 
3 The Message Type Code is in the same place and has a similar function to a Lighting 
Application Group Address 

<!-- page 6 -->

Clipsal Australia Pty Ltd  Document: CBUS-APP/05 
ABN 27 007 873 529  Issue:  
   Date:  
 
C-Bus Security Application 
4.3 
20 March 2007 
 Copyright © 2003 - 2008 Clipsal Integrated Systems Page 6 of 24 
5.5.1.1 System Armed / Disarmed 
Command: $7A 
Arguments: $80, <arm code type> 
Meaning: Security system has just become armed. 
Originator: Security system 
Notes: The arm code type is a further identification of any arm sub-mode into 
which the panel has been placed. The allocation of arm type codes 
shall be at least: 
 $00 = disarmed 
 $01 = fully armed (typically used for “away” modes) 
 $02 = partially armed (typically used for “home” modes) 
 (Optional) $03 – $7F = other arm sub-types, manufacturers discretion 
 $80 – $FF = reserved 
5.5.1.2 System Disarmed 
Command: $01 
Arguments: $80 
Meaning: Security system has just become disarmed. 
Originator: Security system 
Notes: This message is a equivalent to a System Armed / Disarmed 
message with an arm code type of $00. (See section 5.5.1.1). 
 Security Systems are discouraged from issuing this message, all 
other systems must receive this message. 
5.5.1.3 Exit Delay Started 
Command: $09 
Arguments: $81 
Meaning: Security system has comm enced its exit delay processing. 
Originator: Security system 
Notes:  

<!-- page 7 -->

Clipsal Australia Pty Ltd  Document: CBUS-APP/05 
ABN 27 007 873 529  Issue:  
   Date:  
 
C-Bus Security Application 
4.3 
20 March 2007 
 Copyright © 2003 - 2008 Clipsal Integrated Systems Page 7 of 24 
5.5.1.4 Entry Delay Started 
Command: $09 
Arguments: $82 
Meaning: Security system has comm enced its entry delay processing. 
Originator: Security system 
Notes: Entry delay processing will nor mally commence in a security system 
when it detects a zone becoming unsealed in some defined entry 
path. The Entry Delay allows time for disarming the system. If the 
system is not disarmed during the Entry Delay period, the system will 
normally raise an alarm condition. 
5.5.1.5 Alarm On 
Command: $79 
Arguments: $83 
Meaning: Security system has commenced some alarm / notification activity. 
Originator: Security system 
Notes: This command shall not be emitted for a system notifying a disarm 
under duress. 
 This message should be transmitted over C-Bus with Class 2 
(medium high) priority. 
 This message indicates that there is an intruder. 
5.5.1.6 Alarm Off 
Command: $01 
Arguments: $83 
Meaning: Security system alarm is switched off. 
Originator: Security system 
Notes: An Alarm Off message implies that an active alarm condition has 
been cleared. 

<!-- page 8 -->

Clipsal Australia Pty Ltd  Document: CBUS-APP/05 
ABN 27 007 873 529  Issue:  
   Date:  
 
C-Bus Security Application 
4.3 
20 March 2007 
 Copyright © 2003 - 2008 Clipsal Integrated Systems Page 8 of 24 
5.5.1.7 Tamper On 
Command: $79 
Arguments: $84 
Meaning: Security system has det ected tampering becoming active. 
Originator: Security system 
Notes: OPTIONAL MESSAGE 
 This message should be transmitted over C-Bus with Class 2 
(medium high) priority. 
 The security system may, at the discretion of the manufacturer or 
installer, also cause an alarm condition if tampering is detected. In 
this case, an Alarm On message should also be transmitted on 
C-Bus. 
5.5.1.8 Tamper Off 
Command: $01 
Arguments: $84 
Meaning: Security system has detec ted clearing of the tampering. 
Originator: Security system 
Notes: OPTIONAL MESSAGE 
 A security system is expected to continue an alarm condition if 
tampering is removed. 
 Some security systems only allow a tamper condition to be cleared by 
Disarming. 
5.5.1.9 Panic Activated 
Command: $79 
Arguments: $85 
Meaning: Security system has detected operation of panic button. 
Originator: Security system 
Notes: OPTIONAL MESSAGE 
 This message should be transmitted over C-Bus with Class 2 
(medium high) priority. 
 The security system may, at the discretion of the manufacturer or 
installer, also cause an alarm condition if panic is detected. In this 
case, an Alarm On message should also be transmitted on C-Bus. 

<!-- page 9 -->

Clipsal Australia Pty Ltd  Document: CBUS-APP/05 
ABN 27 007 873 529  Issue:  
   Date:  
 
C-Bus Security Application 
4.3 
20 March 2007 
 Copyright © 2003 - 2008 Clipsal Integrated Systems Page 9 of 24 
5.5.1.10 Panic Cleared 
Command: $01 
Arguments: $85 
Meaning: Security system has detected cancellation of the panic condition. 
Originator: Security system 
Notes: OPTIONAL MESSAGE 
 A security system may cancel an alarm condition if panic is removed. 
 Some security systems only allow a panic condition to be cleared by 
Disarming. 
5.5.1.11 Zone Unsealed 
Command: $0A 
Arguments: $86, <zone number> 
Meaning: Security system has detected a zone becoming unsealed (was 
previously sealed). 
Originator: Security system 
Notes: The zone number shall be a single byte, used to indicate the zone 
number of a sensor(s) protecting some kind of physical region. 
 The allocation of zone numbers is at the discretion of the security 
system manufacturer, but shall comply with: 
 $00 = reserved 
 $01 – $7F =zone number normally relates to a sensor(s) protecting a 
region 
 $80 – $FF = reserved. 
5.5.1.12 Zone Sealed 
Command: $0A 
Arguments: $87, <zone number> 
Meaning: Security system has detec ted a zone becoming sealed (was 
previously unsealed). 
Originator: Security system 
Notes: Refer to section 5.5.1.11 for zone numbering convention. 

<!-- page 10 -->

Clipsal Australia Pty Ltd  Document: CBUS-APP/05 
ABN 27 007 873 529  Issue:  
   Date:  
 
C-Bus Security Application 
4.3 
20 March 2007 
 Copyright © 2003 - 2008 Clipsal Integrated Systems Page 10 of 24 
5.5.1.13 Zone Open 
Command: $0A 
Arguments: $88, <zone number> 
Meaning: Security system has detec ted a protected loop zone becoming open 
circuit. 
Originator: Security system 
Notes: A protected loop zone going open circuit normally indicates some 
form of tampering with a sensor. 
 Refer to section 5.5.1.11 for zone numbering convention. 
5.5.1.14 Zone Short 
Command: $0A 
Arguments: $89, <zone number> 
Meaning: Security system has detected a protected loop zone becoming short 
circuit. 
Originator: Security system 
Notes: A protected loop zone going short circuit normally indicates some 
form of tampering with a sensor. 
 Refer to section 5.5.1.11 for zone numbering convention. 
5.5.1.15 Zone Isolated 
Command: $0A 
Arguments: $8A, <zone number> 
Meaning: Security system has isolated a zone. 
Originator: Security system 
Notes: A zone has been isolated (or bypassed, or shunted, depending on 
terminology). That zone will no longer be monitored by the system. 
 A zone can become isolated only after a system is armed. The state 
of a zone (being isolated or not) is cleared to non-isolated when the 
system becomes disarmed.  
 Refer to section 5.5.1.11 for zone numbering convention. 
5.5.1.16 Low Battery Detected 
Command: $79 
Arguments: $8B 
Meaning: Security system has detected t hat its backup battery is running low. 
Originator: Security system 
Notes: OPTIONAL MESSAGE. 
 If supported, the security system shall emit this message when the 
battery has less than 1 hour capacity left. 

<!-- page 11 -->

Clipsal Australia Pty Ltd  Document: CBUS-APP/05 
ABN 27 007 873 529  Issue:  
   Date:  
 
C-Bus Security Application 
4.3 
20 March 2007 
 Copyright © 2003 - 2008 Clipsal Integrated Systems Page 11 of 24 
5.5.1.17 Low Battery Corrected  
Command: $01 
Arguments: $8B 
Meaning: Security system has detected t hat its backup battery was running low, 
and is now acceptable. 
Originator: Security system 
Notes: OPTIONAL MESSAGE. 
 If supported, the security system shall emit this message when the 
battery was previously running low (with less than 1 hour capacity 
left), but due to some corrective action the battery is now acceptable 
again. 
5.5.1.18 Battery Charging 
Command: $0A 
Arguments: $8C, <start/stop> 
Meaning: Security system has started / stopped charging its battery. 
Originator: Security system 
Notes: OPTIONAL MESSAGE. 
 If supported, the security system shall emit this message when it 
starts or stops charging its battery. 
 The <start/stop> byte shall be: 
 $00 = battery charge stopped 
 $FF = battery charge started 
 $01 .. $FE = reserved 

<!-- page 12 -->

Clipsal Australia Pty Ltd  Document: CBUS-APP/05 
ABN 27 007 873 529  Issue:  
   Date:  
 
C-Bus Security Application 
4.3 
20 March 2007 
 Copyright © 2003 - 2008 Clipsal Integrated Systems Page 12 of 24 
5.5.1.19 Zone Name 
Command: $AD 
Arguments: $8D, <zone>, <11 byte name> 
Meaning: Security system has emitted a text name for a zone. 
Originator: Security system 
Notes: OPTIONAL MESSAGE. 
 This is a long argument format message. 4
 If supported, the security system shall emit this message only when 
requested by a Request Zone Name message (refer section 5.5.2.9). 
 The zone name shall be a string of exactly 11 ASCII encoded bytes, 
padded with trailing spaces ($20) if needed. 
 The message can be used to make a mapping between zone names 
and what they mean. (For example, zone 1 might be “KITCHEN    “). 
 Refer to section 0 for zone numbering convention. 
 <11 byte name> = 11 ASCII coded bytes, padded with trailing 
spaces. 
5.5.1.20 Status Report 1 
Command: $AC 
Arguments: $8E, <state>, <tamper status>, <panic status>, 
<status zone 1,2,3,4>, <status zone 5,6,7,8>, …, <status zone 
29,30,31,32> 
Meaning: The security system reports its current status.  
Originator: Security system 
Notes: This is a long argument format message. 
 There shall always be 32 zones reported even if the system supports 
more or less than this. 
 The argument format shall be: 
 <state>:  system arm code – refer to section 5.5.1.1
 <tamper status>: $00 = no tamper 
    $01 .. $FE = reserved 
    $FF = tamper currently active 
 <panic status>: $00 = no panic 
    $01 .. $FE = reserved 
    $FF = panic currently active 
                                                 
4 Due to the above limitation on message length, the total number of argument bytes cannot 
exceed 13 bytes. 

<!-- page 13 -->

Clipsal Australia Pty Ltd  Document: CBUS-APP/05 
ABN 27 007 873 529  Issue:  
   Date:  
 
C-Bus Security Application 
4.3 
20 March 2007 
 Copyright © 2003 - 2008 Clipsal Integrated Systems Page 13 of 24 
<zone status>: Zone status packs 4 zones per byte for a total of 32 
zones reported. Each zone report indicates the state 
of a protected loop zone, as 2 bits in the following 
format: 
    (msb) aabbccdd (lsb) 
    Where: 
     aa = zone 1 (5, 9, etc) state 
     bb = zone 2 (6, 10, etc) state 
     cc = zone 3 (7, 11, etc) state 
     dd = zone 4 (8, 12, etc) state 
    And where: 
     aa, bb, cc, dd can be: 
      %00 = zone sealed 
      %01 = zone unsealed 
      %10 = zone open 
      %11 = zone short 
Zones not present in a system shall always report a 
zone sealed status. 
5.5.1.21 Status Report 2 
Command: $AD 
Arguments: $8F, <status zone 33,34,35,36>, <status zone 37,38,39,40>, …, 
<status zone 77,78,79,80> 
Meaning: The security system reports additional zone status.  
Originator: Security system 
Notes: This is a long argument format message. 
 There shall always be 48 zones reported even if the system supports 
more or less than this. The zones reported shall always be zones 33 
to 80 inclusive. 
 This message is a continuation of Status Report 1. The format for the 
zone status information is the same as Status Report 1. Refer section 
5.5.1.20. 
 Zones not present in a system shall always report a zone sealed 
status. 

<!-- page 14 -->

Clipsal Australia Pty Ltd  Document: CBUS-APP/05 
ABN 27 007 873 529  Issue:  
   Date:  
 
C-Bus Security Application 
4.3 
20 March 2007 
 Copyright © 2003 - 2008 Clipsal Integrated Systems Page 14 of 24 
5.5.1.22 Password Entry Status 
Command: $0A 
Arguments: $90, <code> 
Meaning: The security system reports the status of password entry.  
Originator: Security system 
Notes: OPTIONAL MESSAGE 
 The security system reports the state of password entry, including 
successful attempts, failed attempts, and when entry is barred for a 
time after too many failed attempts. 
 The argument format shall be: 
 <code>: $00 = reserved 
   $01 = password entry succeeded 
   $02 = password entry failed 
   $03 = password entry disabled 
  $04 = password entry enabled again (after previously 
being disabled) 
  $05 - $FF = reserved 
5.5.1.23 Mains Failure 
Command: $79 
Arguments: $91 
Meaning: The security system has detected a failure of its mains power.  
Originator: Security system 
Notes: OPTIONAL MESSAGE 
5.5.1.24 Mains Restored or Applied  
Command: $01 
Arguments: $91 
Meaning: The security system has detected restoration of its mains power.  
Originator: Security system 
Notes: OPTIONAL MESSAGE 

<!-- page 15 -->

Clipsal Australia Pty Ltd  Document: CBUS-APP/05 
ABN 27 007 873 529  Issue:  
   Date:  
 
C-Bus Security Application 
4.3 
20 March 2007 
 Copyright © 2003 - 2008 Clipsal Integrated Systems Page 15 of 24 
5.5.1.25 Arm Ready / Not Ready 
Command: $0A 
Arguments: $92, <zone number> 
Meaning: The security system shows its readiness during Arming.  
Originator: Security system 
Notes: OPTIONAL MESSAGE 
 This message is sent when the security system is being Armed. 
 This message should be sent during Arming if any zones do no seal 
correctly. One message should be sent for each zone that does not 
correctly seal. 
 If the security system Arms correctly, this message should be sent 
with a <zone number> of 0. 
5.5.1.26 Current Alarm Type 
Command  $0A 
Arguments  $93 
Notes:  REMOVED 
This command has now been removed from this application and has 
now become reserved for possible future redefinition. Its capability has 
now been placed into the commands detailed below in paras 
5.5.1.27 
to 5.5.1.36
5.5.1.27 Line Cut Alarm Raised 
Command  $79 
Arguments:  $94 
Meaning:  Security system has detected the attached phone line being cut. 
Originator:  Security system. 
Notes: OPTIONAL MESSAGE 
 The security system may, at the discretion of the manufacturer or 
installer, also cause an alarm condition if line cut is detected. In this 
case, an Alarm On message should also be transmitted on C-Bus. 

<!-- page 16 -->

Clipsal Australia Pty Ltd  Document: CBUS-APP/05 
ABN 27 007 873 529  Issue:  
   Date:  
 
C-Bus Security Application 
4.3 
20 March 2007 
 Copyright © 2003 - 2008 Clipsal Integrated Systems Page 16 of 24 
5.5.1.28 Line Cut Alarm Cleared 
Command  $01 
Arguments:  $94 
Meaning:   Security system has detected the attached phone line being 
reconnected. 
Originator:  Security system. 
Notes: OPTIONAL MESSAGE 
 A security system may cancel an alarm condition if the phone line is 
restored. 
 Some security systems only allow a line cut condition to be cleared by 
Disarming. 
5.5.1.29 Arm Failed Raised 
Command  $79 
Arguments:  $95 
Meaning:  Security system has failed to arm. 
Originator:  Security system. 
Notes: OPTIONAL MESSAGE 
 The security system may, at the discretion of the manufacturer or 
installer, also cause an alarm condition if the system fails to arm. In 
this case, an Alarm On message should also be transmitted on 
C-Bus. 
5.5.1.30 Arm Failed Cleared 
Command  $01 
Arguments:  $95 
Meaning:  Security system has been able to  arm after having previously failed. 
Originator:  Security system. 
Notes: OPTIONAL MESSAGE 
 A security system may cancel an alarm condition if the arm can 
proceed after previously failing. 
 Some security systems only allow an arm failure alarm condition to be 
cleared by Disarming. 

<!-- page 17 -->

Clipsal Australia Pty Ltd  Document: CBUS-APP/05 
ABN 27 007 873 529  Issue:  
   Date:  
 
C-Bus Security Application 
4.3 
20 March 2007 
 Copyright © 2003 - 2008 Clipsal Integrated Systems Page 17 of 24 
5.5.1.31 Fire Alarm Raised 
Command  $79 
Arguments:  $96 
Meaning:  Security system has detected fire. 
Originator:  Security system. 
Notes: OPTIONAL MESSAGE 
 The security system may, at the discretion of the manufacturer or 
installer, also cause an alarm condition if fire is detected. In this case, 
an Alarm On message should also be transmitted on C-Bus. 
5.5.1.32 Fire Alarm Cleared 
Command  $01 
Arguments:  $96 
Meaning:  Security system has detected that a fire condition has ceased. 
Originator:  Security system. 
Notes: OPTIONAL MESSAGE 
 A security system may cancel an alarm condition if a fire condition 
ceases to be detected. 
 Some security systems only allow a fire condition to be cleared by 
Disarming. 
5.5.1.33 Gas Alarm Raised 
Command  $79 
Arguments:  $97 
Meaning:  Security system has detected the presence of gas. 
Originator:  Security system. 
Notes: OPTIONAL MESSAGE 
 The security system may, at the discretion of the manufacturer or 
installer, also cause an alarm condition if gas is detected. In this case, 
an Alarm On message should also be transmitted on C-Bus. 

<!-- page 18 -->

Clipsal Australia Pty Ltd  Document: CBUS-APP/05 
ABN 27 007 873 529  Issue:  
   Date:  
 
C-Bus Security Application 
4.3 
20 March 2007 
 Copyright © 2003 - 2008 Clipsal Integrated Systems Page 18 of 24 
5.5.1.34 Gas Alarm Cleared 
Command  $01 
Arguments:  $97 
Meaning:  Security system has detected that the presence of gas has cleared. 
Originator:  Security system. 
Notes: OPTIONAL MESSAGE 
 A security system may cancel an alarm condition if previously 
detected gas has cleared. 
 Some security systems only allow a gas alarm condition to be cleared 
by Disarming. 
5.5.1.35 Other Alarm Raised 
Command  $79 
Arguments:  $98 
Meaning:  Security system has detected special alarm condition. 
Originator:  Security system. 
Notes: OPTIONAL MESSAGE 
 The security system may, at the discretion of the manufacturer or 
installer, also cause an alarm if a defined condition is detected. In this 
case, an Alarm On message should also be transmitted on C-Bus. 
5.5.1.36 Other Alarm Cleared 
Command  $01 
Arguments:  $98 
Meaning:  Security system has detected the removal of a special alarm condition. 
Originator:  Security system. 
Notes: OPTIONAL MESSAGE 
 A security system may cancel a special alarm if the condition ceases 
to exist. 
 Some security systems only allow a special alarm condition to be 
cleared by Disarming. 
5.5.2 Security System Control Messages 
Security System Control Messages are emitted by any device in a C-Bus network, and 
sent to the security application address as a SAL message. They are only ever 
accepted by a security panel, and cause the panel to perform a specified function. 

<!-- page 19 -->

Clipsal Australia Pty Ltd  Document: CBUS-APP/05 
ABN 27 007 873 529  Issue:  
   Date:  
 
C-Bus Security Application 
4.3 
20 March 2007 
 Copyright © 2003 - 2008 Clipsal Integrated Systems Page 19 of 24 
5.5.2.1 Status 1 Request 
Command: $09 
Arguments: $A0 
Meaning: Sending this message causes the security system to issue a status 
report 1 message in response (Refer section 5.5.1.20).  
Originator: Anywhere 
Notes:  
5.5.2.2 Status 2 Request 
Command: $09 
Arguments: $A1 
Meaning: Sending this message causes the security system to issue a status 
report 2 message in response (Refer section 5.5.1.21).  
Originator: Anywhere 
Notes:  
5.5.2.3 Arm System 
Command: $0A 
Arguments: $A2, <arm mode> 
Meaning: The security system immediately arms itself. 
Originator: Anywhere 
Notes: The security system may support multiple arm modes. The argument 
to this command specifies the arm mode. 
 All listed modes must be supported by mapping to the closest mode 
supported by the security system.  
 The argument format shall be: 
 <arm mode >: $00 = reserved 
    $01 = Arm to Away Mode 
    $02 = Arm to Night (Home) Mode 
    $03 = Arm to Day Mode 
    $04 = Arm to Vacation Mode 
    $05 - $FE = reserved 
    $FF = Arm to highest level of protection 
 

<!-- page 20 -->

Clipsal Australia Pty Ltd  Document: CBUS-APP/05 
ABN 27 007 873 529  Issue:  
   Date:  
 
C-Bus Security Application 
4.3 
20 March 2007 
 Copyright © 2003 - 2008 Clipsal Integrated Systems Page 20 of 24 
5.5.2.4 Raise Tamper 
Command: $79 
Arguments: $A3 
Meaning: The security system imm ediately behaves as though it has been 
tampered with. 
Originator: Anywhere 
Notes:  
5.5.2.5 Drop Tamper 
Command: $01 
Arguments: $A3 
Meaning: The effect of a previous request to raise tamper is cancelled. 
Originator: Anywhere 
Notes: This message shall not cancel any other form of tampering or any 
other condition which could cause the security system to raise an 
alarm. It shall only cancel a previous Raise Tamper message. 
5.5.2.6 Raise Alarm 
Command: $79 
Arguments: $A4 
Meaning: The security system immediately raises an alarm condition. 
Originator: Anywhere 
Notes: This condition shall only be c ancelled by disarming the system. 
5.5.2.7 Emulate Keypad 
Command: $0A 
Arguments: $A5, <key> 
Meaning: A keypress message is sent to the security system, emulating the 
press of a key on its own keypad. 
Originator: Anywhere 
Notes: OPTIONAL MESSAGE 
 This message can be sent to the security system at any time. The 
security system shall behave as though the corresponding key had 
been pressed and released on its own keypad. 
 The security system shall allow these messages and keypresses on 
its own keypad to be interleaved. 
 It shall be possible to disarm the security system by sending the 
disarm (and possibly also duress) sequence, in the correct order, as 
though the code had been entered on the security system control 
panel.  

<!-- page 21 -->

Clipsal Australia Pty Ltd  Document: CBUS-APP/05 
ABN 27 007 873 529  Issue:  
   Date:  
 
C-Bus Security Application 
4.3 
20 March 2007 
 Copyright © 2003 - 2008 Clipsal Integrated Systems Page 21 of 24 
 <key> = a code corresponding to the keypad keys: 
  $00 .. $7F = ASCII code 
  $80 .. $FF = Custom or function keys as determined by the 
security system manufacturer. 
 The following common or special key codes are defined: 
  $0D = ENTER  (ASCII carriage return) 
  $80 = SHIFT  (Key modifier, custom function) 
  $81 = PANIC  (Special purpose key) 
  $82 = FIRE   (Special purpose key) 
  $83 = ARM   (Generic arm to highest level) 
  $84 = AWAY  (Special purpose arm key) 
  $85 = NIGHT  (Special purpose arm key) 
  $86 = DAY   (Special purpose arm key) 
  $87 = VACATION (Special purpose arm key) 
 
5.5.2.8 Display Message 
Command: %111LLLLL 
Arguments: $A6, <message> 
Meaning: Place a text message onto the security panel display. 
Originator: Anywhere 
Notes: OPTIONAL MESSAGE. 
 This is a long argument format message. 
 The “L” bits of the command shall be set according to the number of 
argument bytes (in the range 1 to 19 decimal). 
 If supported, the security system takes the bytes of the argument as 
8-bit ASCII and displays them as a text message on any display it 
may have. 
 The method of clearing this message from the display is at the 
discretion of the security system manufacturer. 

<!-- page 22 -->

Clipsal Australia Pty Ltd  Document: CBUS-APP/05 
ABN 27 007 873 529  Issue:  
   Date:  
 
C-Bus Security Application 
4.3 
20 March 2007 
 Copyright © 2003 - 2008 Clipsal Integrated Systems Page 22 of 24 
5.5.2.9 Request Zone Name 
Command: $0A 
Arguments: $A7, <zone> 
Meaning: The security system immediately outputs the name corresponding to 
the zone number. 
Originator: Anywhere 
Notes: OPTIONAL MESSAGE 
 If supported, the security system shall output a single Zone Name 
message (Refer section 5.5.1.19). 
 Refer to section 0 for zone numbering convention. 
5.6 Message Priority 
C-Bus security application messages shall always be transmitted at the lowest priority 
(Class 4), unless otherwise noted. 
Message priority is part of the C-Bus message header (refer to the C-Bus PC Interface 
documentation), and is set by the two most significant bits of the C-Bus header field, as 
follows: 
 00 = Class 4, lowest priority 
 01 = Class 3, Medium low priority 
 10 = Class 2, Medium high priority 
 11 = Class 1, High priority  
Thus, to send a Class 2 message, use a message header of (for example) $85 instead 
of $05 for a Class 4 message. 
5.7 Internetwork Routing 
C-Bus security applications may receive request messages that have been routed via 
one or more C-Bus bridges or gateway devices. Such messages will be received with a 
message type indicating point-multipoint, but will have a non-zero Network routing. 
To ensure the response is directed back to the correct network, via the same bridges 
and message path, any request messages received with internetwork routing 
information shall: 
a. Always have the response generated as a point-point-multipoint message; and 
b. Use a routing stack derived from the request message, to deliver the response into 
the C-Bus network that originated the request. 
5.8 Application Behaviour 
5.8.1 Concatenated Commands 
A Security Application device may receive a message containing more bytes than a 
single command. This permits a single C-Bus transmission to contain multiple 
commands for a single application. 
Devices using C-Bus Security Application messages must process all received bytes. 
This is achieved by placing the received bytes in a buffer, and using the following 
simple algorithm: 

<!-- page 23 -->

Clipsal Australia Pty Ltd  Document: CBUS-APP/05 
ABN 27 007 873 529  Issue:  
   Date:  
 
C-Bus Security Application 
4.3 
20 March 2007 
 Copyright © 2003 - 2008 Clipsal Integrated Systems Page 23 of 24 
WHILE the buffer contains bytes LOOP 
The first byte defines the command type and argument 
count (refer section 5.4). 
 Process the first (command) byte and its arguments 
Once processed, remove the command and argument bytes 
from the buffer 
END LOOP 
5.8.2 State 
C-Bus security systems shall maintain sufficient internal state to support the mandatory 
messages. 
5.9 Status Reporting 
C-Bus security applications shall not respond to C-Bus status request (MMI) 
messages. 
5.10 Limitations 
A single C-Bus network cannot contain more than 1 security control system. 
5.11 Examples 
These examples assume the Security System interfaces to C-Bus using the C-Bus 
Serial Interface, which is described in more detail in CBUS-SIUG. 
The examples assume the Serial Interface SRCHK option is set, so data transfer both 
to and from the Serial Interface uses a checksum. 
5.11.1 Security System Emits “Alarm On” 
Refer to section 5.5.1.5 (Page 7). The security system could issue: 
 To PCI: \05D00079832F 
However, this would be sent as a Class 4 (lowest priority) message. The definition 
requires that this message be transmitted as Priority Class 2. Therefore, the first byte 
needs to be changed to $85. The correct transmission is: 
 To PCI: \85D0007983AF 
5.11.2 Security System Reports “Zone 3 Unsealed” 
Refer to section 5.5.1.11 (Page 8). The security system would issue: 
 To PCI: \05D0000A860398 
5.11.3 Security System Issues a “Zone Name” 
Refer to section 5.5.1.19 (Page 12). Suppose that Zone 3 is the KITCHEN (ASCII: $4B, 
$49, $54, $43, $48, $45, $2E) ASCII space is $20, and a request was received on the 
local network for a Zone Name to be transmitted. The security system would issue: 
 To PCI: \05D000AD8D034B49544348452E2020202088 

<!-- page 24 -->

Clipsal Australia Pty Ltd  Document: CBUS-APP/05 
ABN 27 007 873 529  Issue:  
   Date:  
 
C-Bus Security Application 
4.3 
20 March 2007 
 Copyright © 2003 - 2008 Clipsal Integrated Systems Page 24 of 24 
5.11.4 Device Requests Security System to Arm 
Refer to section 5.5.2.3 (Page19). To arm a security system on the local network to its 
highest level of protection, some device would issue: 
 To PCI: \05D0000AA2FF80 
To arm a security system on a remote network (through a single bridge with unit 
address $92 on the side of the sending device, and unit address $43 on the side of the 
security system), a device would issue: 
 To PCI: \03 9209D00AA2FFE7 
The internetwork routing bytes ($9209) would be modified by the bridge as the 
message passed through, to construct the reverse route ($43D001). 
 
5.12 Appendix 
5.12.1 Handling of Disarming Under Duress 
An important feature of a security system is that if it is disarmed under duress, there 
shall be no apparent difference in behaviour of the system. If the security system alerts 
a remote monitoring station (for example by telephone), this must be done in an 
inconspicuous manner. If the system behaviour indicates that the duress alarm has 
been raised, it could potentially endanger the user. 
For this reason, the Security Application does not support messages indicating duress, 
which could be used to change the system behaviour between a normal disarm and a 
disarm under duress.  
5.12.2 Disarming a Security System via C-Bus 
C-Bus makes no provision for disarming a Security System using single bus messages. 
To do so would create a significant vulnerability. 
If a manufacturer chooses to support it, Security Systems can be disarmed using the 
“Emulate keypad” messages, which ensure that a user still enters codes or identity 
numbers. 
 