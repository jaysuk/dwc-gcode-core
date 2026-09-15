; fff-basic fixture (task 13) - a minimal but real FFF configuration
G90
M83
global toolTemp = 210

M584 X0 Y1 Z2 E3
M574 X1 S1 P"io0.in"
M574 Y1 S1 P"io1.in"
M574 Z1 S2

M308 S0 P"temp0" Y"thermistor"
M950 H0 C"out0" T0
M143 H0 S280

M308 S1 P"temp1" Y"thermistor"
M950 H1 C"out1" T1

M563 P0 D0 H1 F0
G10 P0 S{global.toolTemp} R150

M950 F0 C"fan0"
M106 P0 S0

M558 K0 C"^io1.in" H5 F120 T6000
G31 K0 P500 X0 Y0 Z0.7

if global.toolTemp > 0
	M950 R0 C"io2.out"
endif
